/**
 * Gmail scanning. Two jobs:
 *  1. Gradescope submission receipts -> re-check Gradescope right away (no LLM).
 *  2. Other USC mail that mentions a date -> Claude Haiku extracts deadlines and
 *     events. Deadlines/exams join the planner like any assignment; required
 *     events go on Coursework; optional ones go on the "maybe" calendar.
 */

// Labels only: reading mail through Apps Script never changes read/unread.
var CHECKED_LABEL = 'duesync/checked';   // every email duesync looked at
var ADDED_LABEL = 'duesync/added';       // emails that put something on your calendar

var EXTRACT_TOOL = {
  name: 'record_items',
  description: 'Record every concrete, future-dated deadline or event in the email. Return an empty list if none.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['deadline', 'exam', 'event'],
                    description: 'deadline = something to submit/complete by a time; exam = a test/quiz taken at a time; event = something to attend' },
            title: { type: 'string', description: 'Short, specific title, e.g. "PA4: Pixel Art" or "Viterbi Career Fair"' },
            course: { type: 'string', description: 'Course code like "CSCI 103" if it belongs to a course, else ""' },
            start: { type: 'string', description: 'ISO 8601 with UTC offset. For deadlines: the due time. Missing time on a deadline: 23:59 local.' },
            end: { type: 'string', description: 'ISO 8601 end for events if stated, else ""' },
            all_day: { type: 'boolean' },
            location: { type: 'string' },
            commitment: { type: 'string', enum: ['required', 'optional', 'ignore'] },
            reason: { type: 'string', description: 'One short phrase on why this commitment level' }
          },
          required: ['kind', 'title', 'course', 'start', 'commitment']
        }
      }
    },
    required: ['items']
  }
};

function claudeExtract_(msg, now) {
  var key = secret_('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');
  var system = 'You extract calendar items from a student\'s email. Today is ' + fmt_(new Date(now), "EEEE yyyy-MM-dd HH:mm Z") +
    ' (' + CONFIG.TIMEZONE + '). Resolve relative dates ("next Friday") against the email\'s sent date. ' +
    'Only include items with a specific date. Skip anything already in the past.\n\nAbout the student: ' + CONFIG.ABOUT_ME +
    '\n\nCommitment policy:\n' + CONFIG.EMAIL_POLICY;
  var payload = {
    model: CONFIG.EMAIL.MODEL, max_tokens: 1500, system: system,
    tools: [EXTRACT_TOOL], tool_choice: { type: 'tool', name: 'record_items' },
    messages: [{ role: 'user', content:
      'From: ' + msg.from + '\nSent: ' + msg.date + '\nSubject: ' + msg.subject + '\n\n' + msg.body.slice(0, CONFIG.EMAIL.BODY_CHARS) }]
  };
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    });
    var code = res.getResponseCode();
    if (code === 200) {
      var out = JSON.parse(res.getContentText());
      var use = (out.content || []).filter(function (c) { return c.type === 'tool_use'; })[0];
      return use && use.input && use.input.items ? use.input.items : [];
    }
    if (code !== 429 && code < 500) throw new Error('Claude API ' + code + ': ' + res.getContentText().slice(0, 300));
    Utilities.sleep(2000 * (attempt + 1));
  }
  throw new Error('Claude API unavailable (retried)');
}

function isGradescopeReceipt_(msg) {
  return /gradescope\.com/i.test(msg.from) && /submi(tted|ssion)/i.test(msg.subject + ' ' + msg.body.slice(0, 500));
}

/** Gmail -> plain message objects (adapter, so tests can fake Gmail). */
function gmailSource_() {
  return {
    threads: function () {
      var q = (storeGet_('state', {}).seenMsgs || []).length ? CONFIG.EMAIL.QUERY : CONFIG.EMAIL.QUERY.replace(/\s*-label:\S+/, '');
      return GmailApp.search(q, 0, CONFIG.EMAIL.MAX_THREADS_PER_RUN).map(function (t) {
        return {
          ref: t, link: t.getPermalink(),
          messages: t.getMessages().map(function (m) {
            return { id: m.getId(), from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toString(),
                     body: m.getPlainBody() || stripTags_(m.getBody()) };
          })
        };
      });
    },
    markDone: function (thread, added) {
      var get = function (n) { return GmailApp.getUserLabelByName(n) || GmailApp.createLabel(n); };
      thread.ref.addLabel(get(CHECKED_LABEL));
      if (added) thread.ref.addLabel(get(ADDED_LABEL));
    }
  };
}

/**
 * @return {gsReceipt: bool, newItems: n, events: [...extracted events to place], errors: [...]}
 * Email deadlines persist in state.emailItems; message ids in state.seenMsgs.
 */
function scanEmail_(gmail, state, now, extract) {
  extract = extract || claudeExtract_;
  var seen = {}; (state.seenMsgs || []).forEach(function (id) { seen[id] = 1; });
  var out = { gsReceipt: false, newItems: 0, events: [], errors: [], toLabel: [] }, calls = 0;
  var emailItems = unpackItems_(state.emailItems);

  gmail.threads().forEach(function (thread) {
    var complete = true, added = false;
    thread.messages.forEach(function (m) {
      if (seen[m.id]) return;
      if (isGradescopeReceipt_(m)) { out.gsReceipt = true; seen[m.id] = 1; return; }
      if (!CONFIG.EMAIL.PREFILTER.test(m.subject + ' ' + m.body.slice(0, 3000))) { seen[m.id] = 1; return; }
      if (calls >= CONFIG.EMAIL.MAX_LLM_CALLS_PER_RUN || overBudget_()) { complete = false; return; }   // finish next run
      calls++;
      var extracted;
      try { extracted = extract(m, now); }
      catch (e) {
        out.errors.push(String(e.message || e));
        var fails = state.emailFails || (state.emailFails = {});
        fails[m.id] = (fails[m.id] || 0) + 1;
        if (fails[m.id] >= 3) { delete fails[m.id]; seen[m.id] = 1; }   // give up: don't burn credits on it forever
        else complete = false;
        return;
      }
      if (state.emailFails) delete state.emailFails[m.id];
      seen[m.id] = 1;
      extracted.forEach(function (x) {
        var start = new Date(x.start);
        if (isNaN(start) || start.getTime() < now || x.commitment === 'ignore') return;
        if (x.kind === 'deadline' || x.kind === 'exam') {
          var it = { uid: 'em:' + stableId_(x.title.toLowerCase(), dayKey_(start)), source: 'email',
                     course: x.course || courseLabel_(x.title), title: x.title, due: start, url: thread.link,
                     submitted: false, extra: { from: m.from, subject: m.subject, optional: x.commitment === 'optional' } };
          if (!emailItems.some(function (e) { return e.uid === it.uid; })) { emailItems.push(it); out.newItems++; }
          added = true;
        } else {
          out.events.push({ title: x.title, course: x.course || '', start: start,
                            end: x.end && !isNaN(new Date(x.end)) ? new Date(x.end) : new Date(start.getTime() + HOUR),
                            allDay: !!x.all_day, location: x.location || '', optional: x.commitment !== 'required',
                            reason: x.reason || '', link: thread.link, subject: m.subject });
          added = true;
        }
      });
    });
    if (complete) out.toLabel.push({ thread: thread, added: added });   // labeled by runOnce_ after state is saved
  });

  state.emailItems = packItems_(emailItems.filter(function (e) { return e.due.getTime() > now - 7 * DAY; }).slice(-150));
  state.seenMsgs = Object.keys(seen).slice(-600);
  return out;
}

/** Put extracted events on a calendar once (they're not re-planned like deadlines). */
function placeEvents_(cal, events, state, now, dryRun) {
  var placed = state.placedEvents || {}, n = 0;
  events.forEach(function (ev) {
    var fp = stableId_(ev.title.toLowerCase(), dayKey_(ev.start));
    if (placed[fp]) return;
    var calId = ev.optional
      ? (state.maybeCalendarId = cal.ensure(CONFIG.MAYBE_CALENDAR_NAME, state.maybeCalendarId))
      : (state.calendarId = cal.ensure(CONFIG.CALENDAR_NAME, state.calendarId));
    // Already on your calendar (added by hand, or by an earlier email)?
    var near = [];
    ['primary', state.calendarId, state.maybeCalendarId].filter(Boolean).forEach(function (c) {
      try { near = near.concat(cal.overlapping(c, new Date(ev.start.getTime() - 30 * MIN), new Date(ev.end.getTime() + 30 * MIN))); } catch (e) { /* skip */ }
    });
    if (near.some(function (e) { return e.status !== 'cancelled' && similarity_(e.summary || '', ev.title) >= 0.5; })) { placed[fp] = now; return; }
    var title = ev.course ? ev.course + ' · ' + ev.title : ev.title;
    var body = {
      summary: (ev.optional ? '❔ ' : '') + title,
      location: ev.location,
      description: (ev.reason ? ev.reason + '\n' : '') + 'From email: ' + ev.subject + '\n' + ev.link +
        (ev.optional ? '\n\nWant to go? Open this event and change its calendar to your main one.' : ''),
      start: ev.allDay ? { date: dayKey_(ev.start) } : { dateTime: iso_(ev.start), timeZone: CONFIG.TIMEZONE },
      end: ev.allDay ? { date: addDaysKey_(dayKey_(ev.start), 1) } : { dateTime: iso_(ev.end), timeZone: CONFIG.TIMEZONE },
      transparency: ev.optional ? 'transparent' : 'opaque',
      colorId: ev.optional ? CONFIG.COLORS.maybe : CONFIG.COLORS.event,
      reminders: { useDefault: false, overrides: ev.optional ? [] : [{ method: 'popup', minutes: 60 }] },
      extendedProperties: props_('ev:' + fp, ev.optional ? 'maybe' : 'event')
    };
    if (!dryRun) cal.insert(calId, body);
    placed[fp] = now; n++;
  });
  for (var k in placed) if (placed[k] < now - 60 * DAY) delete placed[k];
  state.placedEvents = placed;
  return n;
}
