/**
 * Reconciles the item list with the Coursework calendar. Everything DueSync
 * creates carries a private extended property (duesync=1, uid, kind), so it can
 * update and clean up its own events and never touches anything else.
 */

var TAG = 'duesync';
var DONE_MARKS = ['✅', '✔', '✓', '[x]', 'done:', 'DONE'];

/** Calendar writes are rate-limited per user: pace them and back off on "Rate Limit Exceeded". */
function calWrite_(fn) {
  for (var attempt = 0; ; attempt++) {
    try { var r = fn(); Utilities.sleep(250); return r; }
    catch (e) {
      if (!/rate ?limit|quota|429|403.*(usage|rate)/i.test(String(e)) || attempt >= 4 || overBudget_()) throw e;
      Utilities.sleep(1000 * Math.pow(2, attempt));   // 1, 2, 4, 8, 16 s
    }
  }
}

/** Thin adapter over the Calendar advanced service (swapped for a fake in tests). */
function googleCal_() {
  return {
    ensure: function (name, knownId) {
      if (knownId) { try { Calendar.Calendars.get(knownId); return knownId; } catch (e) { /* recreate */ } }
      var page;
      do {
        var res = Calendar.CalendarList.list({ pageToken: page });
        var hit = (res.items || []).filter(function (c) { return c.summary === name; })[0];
        if (hit) return hit.id;
        page = res.nextPageToken;
      } while (page);
      return Calendar.Calendars.insert({ summary: name, timeZone: CONFIG.TIMEZONE, description: 'Managed by DueSync' }).id;
    },
    list: function (calId, tmin, tmax) {
      var out = [], page;
      do {
        var res = Calendar.Events.list(calId, {
          timeMin: iso_(tmin), timeMax: iso_(tmax), privateExtendedProperty: TAG + '=1',
          showDeleted: true, singleEvents: true, maxResults: 2500, pageToken: page
        });
        out = out.concat(res.items || []);
        page = res.nextPageToken;
      } while (page);
      return out;
    },
    // Google rejects free/busy ranges longer than ~3 months, so ask in 60-day windows.
    freebusy: function (ids, tmin, tmax) {
      if (!ids.length) return [];
      var out = [], step = 60 * DAY, end = new Date(tmax).getTime();
      for (var s = new Date(tmin).getTime(); s < end; s += step) {
        var res = Calendar.Freebusy.query({ timeMin: iso_(s), timeMax: iso_(Math.min(s + step, end)),
                                            items: ids.map(function (i) { return { id: i }; }) });
        for (var k in res.calendars) (res.calendars[k].busy || []).forEach(function (b) {
          out.push([new Date(b.start).getTime(), new Date(b.end).getTime()]);
        });
      }
      return merge_(out);
    },
    overlapping: function (calId, tmin, tmax) {
      var res = Calendar.Events.list(calId, { timeMin: iso_(tmin), timeMax: iso_(tmax), singleEvents: true, maxResults: 50 });
      return res.items || [];
    },
    insert: function (calId, body) { return calWrite_(function () { return Calendar.Events.insert(body, calId); }); },
    patch: function (calId, id, body) { return calWrite_(function () { return Calendar.Events.patch(body, calId, id); }); },
    remove: function (calId, id) {
      try { calWrite_(function () { Calendar.Events.remove(calId, id); }); }
      catch (e) { if (!/404|410|deleted/i.test(String(e))) throw e; }
    }
  };
}

function props_(uid, kind) { return { private: { duesync: '1', uid: uid, kind: kind } }; }

function evRange_(ev) {
  if (!ev.start || !ev.start.dateTime) return null;
  return [new Date(ev.start.dateTime).getTime(), new Date(ev.end.dateTime).getTime()];
}

function tierColor_(name) { return CONFIG.COLORS[name] || CONFIG.COLORS.small; }

function dueBody_(p) {
  var it = p.item, t = p.tier, done = it.submitted, lines = ['Due: ' + prettyDate_(it.due)];
  if (it.extra && it.extra.late_due) lines.push('Late due: ' + prettyDate_(new Date(it.extra.late_due)));
  if (it.source === 'syllabus') lines.push('From syllabus "' + it.extra.fileName + '": tentative, confirm with the course.' +
    (it.extra.note ? ' Note: ' + it.extra.note : ''));
  if (it.url) lines.push('Link: ' + it.url);
  var src = it.source + (it.extra && it.extra.also_on ? ' (also on ' + it.extra.also_on.join(', ') + ')' : '');
  lines.push('Source: ' + src + ' · size: ' + t.name);
  if (CONFIG.WORK_BLOCKS !== false && t.workMin && !done) {
    lines.push('Work plan: ' + (p.planned / 60).toFixed(1) + 'h of ' + (t.workMin / 60).toFixed(1) + 'h scheduled' +
      (p.startKey ? ' (start by ' + fmt_(dayStart_(p.startKey), 'EEE MMM d') + ')' : ''));
    if (p.shortfallMin) lines.push('⚠ Your calendar is full: ' + (p.shortfallMin / 60).toFixed(1) + 'h could not be scheduled before the deadline.');
  }
  lines.push('\nDone? Rename this event to start with ✅ (or delete it to stop tracking). Gradescope submissions are detected automatically.');
  return {
    summary: (done ? '✅ ' : '') + itemLabel_(it) + ' — due',
    description: lines.join('\n'),
    start: { dateTime: iso_(it.due.getTime() - 30 * MIN), timeZone: CONFIG.TIMEZONE },
    end: { dateTime: iso_(it.due), timeZone: CONFIG.TIMEZONE },
    transparency: 'transparent',
    colorId: done ? CONFIG.COLORS.done : tierColor_(t.name),
    reminders: { useDefault: false, overrides: done ? [] : t.reminders.map(function (m) { return { method: 'popup', minutes: m }; }) },
    extendedProperties: props_(it.uid, 'due')
  };
}

/** All-day banner across every day from the start date through the due date. */
function startBody_(p) {
  var it = p.item, dueKey = dayKey_(it.due);
  return {
    summary: '📌 ' + itemLabel_(it) + ' — due ' + fmt_(it.due, 'EEE M/d h:mma').replace(':00', '') +
      (it.source === 'syllabus' ? ' (tentative)' : ''),
    description: 'Due ' + prettyDate_(it.due) + '\n' + (it.url || '') +
      '\n\nThis banner stays on your calendar every day until it\'s due. Done early? Rename the deadline event to start with ✅ and it disappears.',
    start: { date: p.startKey < dueKey ? p.startKey : dueKey },
    end: { date: addDaysKey_(dueKey, 1) },
    transparency: 'transparent',
    colorId: tierColor_(p.tier.name),
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: props_(it.uid, 'start')
  };
}

function blockBody_(p, s, e) {
  var it = p.item, study = p.tier.label.toLowerCase() === 'study';
  return {
    summary: (study ? '📖 ' : '🛠 ') + p.tier.label + ': ' + itemLabel_(it),
    description: 'Due ' + prettyDate_(it.due) + '\n' + (it.url || '') +
      '\n\nBad time? Drag this block elsewhere (it stays put) or delete it (that slot won\'t be reused).',
    start: { dateTime: iso_(s), timeZone: CONFIG.TIMEZONE },
    end: { dateTime: iso_(e), timeZone: CONFIG.TIMEZONE },
    transparency: 'opaque',
    colorId: tierColor_(p.tier.name),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    extendedProperties: props_(it.uid, 'block')
  };
}

function changed_(ev, body) {
  var keys = ['summary', 'description', 'colorId', 'transparency'];
  for (var i = 0; i < keys.length; i++) if ((ev[keys[i]] || null) !== (body[keys[i]] || null)) return true;
  if (body.start.dateTime) {
    var r = evRange_(ev);
    if (!r || r[0] !== new Date(body.start.dateTime).getTime() || r[1] !== new Date(body.end.dateTime).getTime()) return true;
  } else if ((ev.start || {}).date !== body.start.date || (ev.end || {}).date !== body.end.date) return true;
  var a = ((ev.reminders || {}).overrides || []).map(function (o) { return o.minutes; }).sort().join(',');
  var b = ((body.reminders || {}).overrides || []).map(function (o) { return o.minutes; }).sort().join(',');
  return a !== b;
}

function sourceOf_(uid) { return { gs: 'gradescope', bs: 'brightspace', cd: 'codio', em: 'email', sy: 'syllabus' }[String(uid).split(':')[0]]; }

/**
 * @param items  all items from every source (due: Date)
 * @param failed set of source names with no data this run (their events are left alone)
 * @param state  persisted object (mutated)
 */
function reconcile_(cal, items, failed, now, state, dryRun) {
  var calId = cal.ensure(CONFIG.CALENDAR_NAME, state.calendarId);
  state.calendarId = calId;
  var horizon = now + CONFIG.HORIZON_DAYS * DAY;
  var dismissed = {}; (state.dismissed || []).forEach(function (u) { dismissed[u] = 1; });
  var blockTimes = state.blockTimes || (state.blockTimes = {});
  var vetoed = (state.vetoed || []).filter(function (v) { return v[1] > now; });

  var dueEv = {}, startEv = {}, blocks = {};
  cal.list(calId, new Date(now - 60 * DAY), new Date(horizon + 30 * DAY)).forEach(function (ev) {
    var pr = (ev.extendedProperties || {}).private || {}, uid = pr.uid, kind = pr.kind;
    if (ev.status === 'cancelled') {
      if (kind === 'due') dismissed[uid] = 1;                       // you deleted the deadline: stop tracking
      else if (kind === 'block' && blockTimes[ev.id]) {             // you deleted a block: avoid that slot
        if (blockTimes[ev.id][1] > now) vetoed.push(blockTimes[ev.id]);
        delete blockTimes[ev.id];
      }
      return;
    }
    if (kind === 'due') dueEv[uid] = ev;
    else if (kind === 'start') startEv[uid] = ev;
    else if (kind === 'block') {
      var r = evRange_(ev);
      if (r) (blocks[uid] = blocks[uid] || []).push({ id: ev.id, start: r[0], end: r[1] });
    }
  });

  items = dedupe_(items.filter(function (i) { return i.due.getTime() >= now - 7 * DAY && i.due.getTime() <= horizon; }))
    .filter(function (i) { return !dismissed[i.uid]; });
  items.forEach(function (it) {
    var ev = dueEv[it.uid];
    if (ev && !it.submitted && DONE_MARKS.some(function (m) { return String(ev.summary || '').trim().indexOf(m) === 0; })) {
      it.submitted = true;
      it.extra = it.extra || {}; it.extra.manual_done = true;
    }
  });

  var seen = {}; items.forEach(function (i) { seen[i.uid] = 1; });
  var frozen = [];
  Object.keys(blocks).forEach(function (uid) {
    if (!seen[uid] && failed[sourceOf_(uid)]) blocks[uid].forEach(function (b) { frozen.push([b.start, b.end]); });
  });

  var busyIds = CONFIG.SCHEDULE.BUSY_CALENDARS.filter(function (c) { return c !== calId; });
  var external = cal.freebusy(busyIds, new Date(now), new Date(horizon));
  var plans = planAll_(items, blocks, external.concat(frozen), vetoed, now);

  var rep = { created: 0, updated: 0, deleted: 0, deferred: 0, plans: plans }, writes = 0;
  function act(kind, fn) {
    if (!dryRun && (writes >= CONFIG.MAX_CALENDAR_WRITES_PER_RUN || overBudget_())) { rep.deferred++; return null; }
    writes++; rep[kind]++;
    return dryRun ? null : fn();
  }

  plans.forEach(function (p) {
    var it = p.item, due = it.due.getTime();
    var body = dueBody_(p), ev = dueEv[it.uid];
    if (!ev) { if (due > now && !it.submitted) act('created', function () { return cal.insert(calId, body); }); }
    else if (changed_(ev, body)) act('updated', function () { return cal.patch(calId, ev.id, body); });

    var sev = startEv[it.uid];
    if (p.startKey && !it.submitted && due > now) {
      var sb = startBody_(p);
      if (!sev) act('created', function () { return cal.insert(calId, sb); });
      else if (changed_(sev, sb)) act('updated', function () { return cal.patch(calId, sev.id, sb); });
    } else if (sev && it.submitted) act('deleted', function () { return cal.remove(calId, sev.id); });

    p.del.forEach(function (b) { act('deleted', function () { return cal.remove(calId, b.id); }); delete blockTimes[b.id]; });
    p.create.forEach(function (c) {
      var made = act('created', function () { return cal.insert(calId, blockBody_(p, c[0], c[1])); });
      if (made) blockTimes[made.id] = [c[0], c[1]];
    });
    p.keep.forEach(function (b) { blockTimes[b.id] = [b.start, b.end]; });
  });

  // Gone from a source that worked (deleted/renamed by the instructor): clear future blocks.
  var planned = {}; plans.forEach(function (p) { planned[p.item.uid] = 1; });
  Object.keys(blocks).forEach(function (uid) {
    if (planned[uid] || failed[sourceOf_(uid)]) return;
    blocks[uid].forEach(function (b) {
      if (b.start > now) { act('deleted', function () { return cal.remove(calId, b.id); }); delete blockTimes[b.id]; }
    });
  });

  state.dismissed = Object.keys(dismissed);
  state.vetoed = vetoed;
  return rep;
}
