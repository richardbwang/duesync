/**
 * Decides how big each assignment is, how early to warn you, and when to work
 * on it. Pure logic on plain data (times are epoch ms), so it is unit-tested.
 */

var GCAL_MAX_REMINDER_MIN = 40320; // Google caps popups at 4 weeks
var SOURCE_RANK = { gradescope: 0, coursesite: 1, codio: 1, brightspace: 2, email: 3, syllabus: 4 };

function classify_(item) {
  var chosen = CONFIG.DEFAULT_TIER, over = {};
  var hay = (item.course || '') + ' ' + item.title;
  for (var i = 0; i < CONFIG.RULES.length; i++) {
    var r = CONFIG.RULES[i];
    if (r.course && !new RegExp(r.course, 'i').test(item.course || '')) continue;
    if (r.match && !new RegExp(r.match).test(hay)) continue;
    if (r.min_points != null && (item.points || 0) < r.min_points) continue;
    chosen = r.tier || chosen;
    ['work_hours', 'start_days_before', 'label', 'reminders'].forEach(function (k) { if (r[k] != null) over[k] = r[k]; });
    break;
  }
  var t = {}, base = CONFIG.TIERS[chosen], k;
  for (k in base) t[k] = base[k];
  for (k in over) t[k] = over[k];
  var rem = {};
  (t.reminders || []).forEach(function (x) { rem[Math.min(minutes_(x), GCAL_MAX_REMINDER_MIN)] = 1; });
  return {
    name: chosen,
    reminders: Object.keys(rem).map(Number).sort(function (a, b) { return b - a; }).slice(0, 5),
    startDays: t.start_days_before || 0,
    workMin: Math.round((t.work_hours || 0) * 60),
    label: t.label || 'Work'
  };
}

/** Same assignment on two platforms -> keep the richest copy. */
function dedupe_(items) {
  var sorted = items.slice().sort(function (a, b) {
    return (SOURCE_RANK[a.source] - SOURCE_RANK[b.source]) || (a.due - b.due);
  });
  var kept = [];
  sorted.forEach(function (it) {
    var dup = null;
    for (var i = 0; i < kept.length && !dup; i++) {
      var k = kept[i];
      if (k.source === it.source) continue;
      // Syllabus dates are tentative: a real listing up to a week away replaces them.
      var tol = (k.source === 'syllabus' || it.source === 'syllabus') ? 7 * DAY : 3 * HOUR;
      if (Math.abs(k.due - it.due) > tol) continue;
      if (it.course && k.course && it.course !== k.course) continue;
      if (similarity_(k.title, it.title) >= 0.5) dup = k;
    }
    if (!dup) { kept.push(it); return; }
    dup.extra = dup.extra || {};
    (dup.extra.also_on = dup.extra.also_on || []).push(it.source);
    dup.course = dup.course || it.course;
    dup.url = dup.url || it.url;
  });
  return kept;
}

// ---- intervals: [startMs, endMs] ----

function merge_(iv) {
  var s = iv.slice().sort(function (a, b) { return a[0] - b[0]; }), out = [];
  s.forEach(function (x) {
    if (out.length && x[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], x[1]);
    else out.push([x[0], x[1]]);
  });
  return out;
}

function subtract_(base, cut) {
  cut = merge_(cut);
  var res = [];
  base.forEach(function (b) {
    var cur = b[0];
    for (var i = 0; i < cut.length; i++) {
      var c = cut[i];
      if (c[1] <= cur || c[0] >= b[1]) continue;
      if (c[0] > cur) res.push([cur, c[0]]);
      cur = Math.max(cur, c[1]);
      if (cur >= b[1]) break;
    }
    if (cur < b[1]) res.push([cur, b[1]]);
  });
  return res;
}

function overlaps_(a, ivs) {
  return ivs.some(function (x) { return a[0] < x[1] && x[0] < a[1]; });
}

function ceil15_(t) { var q = 15 * MIN; return Math.ceil(t / q) * q; }

function hm_(s) { var p = s.split(':'); return [parseInt(p[0], 10), parseInt(p[1], 10)]; }

function dailyWindows_(start, end) {
  var out = [], key = dayKey_(new Date(start)), last = dayKey_(new Date(end)), S = CONFIG.SCHEDULE;
  for (var guard = 0; key <= last && guard < 400; guard++, key = addDaysKey_(key, 1)) {
    var w = weekday_(key) >= 6 ? S.WEEKEND_WINDOW : S.WEEKDAY_WINDOW;
    var p = key.split('-'), a = hm_(w[0]), b = hm_(w[1]);
    var ws = localDate_(+p[0], +p[1], +p[2], a[0], a[1]).getTime();
    var we = (w[1] === '24:00' || w[1] === '00:00') ? dayStart_(addDaysKey_(key, 1)).getTime()
      : localDate_(+p[0], +p[1], +p[2], b[0], b[1]).getTime();
    var s = Math.max(ws, start), e = Math.min(we, end);
    if (s < e) out.push([s, e]);
  }
  return out;
}

/**
 * @param items        deduped items (due: Date)
 * @param existing     uid -> [{id, start, end}] work blocks already on the calendar
 * @param externalBusy [[s,e]] busy time from your other calendars
 * @param vetoed       [[s,e]] slots you deleted blocks from
 * @return plans [{item, tier, startKey, keep, del, create, doneMin, shortfallMin, planned}]
 */
function planAll_(items, existing, externalBusy, vetoed, now) {
  var S = CONFIG.SCHEDULE, buf = S.BUFFER_MINUTES * MIN;
  var itemCap = S.MAX_HOURS_PER_DAY_PER_ITEM * 60, totalCap = S.MAX_HOURS_PER_DAY_TOTAL * 60;
  var busy = merge_(externalBusy.map(function (x) { return [x[0] - buf, x[1] + buf]; }).concat(vetoed));
  var dayLoad = {};
  function addLoad(s, e) { var k = dayKey_(new Date(s)); dayLoad[k] = (dayLoad[k] || 0) + Math.round((e - s) / MIN); }
  function blockMin(b) { return Math.round((b.end - b.start) / MIN); }
  function planned(p) {
    return p.doneMin + p.keep.reduce(function (a, b) { return a + blockMin(b); }, 0) +
      p.create.reduce(function (a, c) { return a + Math.round((c[1] - c[0]) / MIN); }, 0);
  }

  var plans = items.slice().sort(function (a, b) { return a.due - b.due; }).map(function (it) {
    var tier = classify_(it), due = it.due.getTime();
    var p = { item: it, tier: tier, startKey: null, keep: [], del: [], create: [], doneMin: 0, shortfallMin: 0 };
    if (tier.startDays) p.startKey = addDaysKey_(dayKey_(it.due), -tier.startDays);
    (existing[it.uid] || []).slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (b) {
      if (b.end <= now) p.doneMin += blockMin(b);
      else if (CONFIG.WORK_BLOCKS === false || it.submitted || !tier.workMin || b.end > due || (b.start > now && overlaps_([b.start, b.end], externalBusy))) p.del.push(b);
      else p.keep.push(b);
    });
    while (p.keep.length && planned(p) - blockMin(p.keep[p.keep.length - 1]) >= tier.workMin) p.del.push(p.keep.pop());
    p.keep.forEach(function (b) { busy = merge_(busy.concat([[b.start - buf, b.end + buf]])); addLoad(b.start, b.end); });
    return p;
  });

  plans.forEach(function (p) {
    var it = p.item, tier = p.tier, due = it.due.getTime();
    if (CONFIG.WORK_BLOCKS === false || it.submitted || !tier.workMin || due <= now) { p.planned = planned(p); return; }
    var need = tier.workMin - planned(p);
    if (need > 0) {
      need = Math.ceil(need / 15) * 15;
      var start = ceil15_(Math.max(now, p.startKey ? dayStart_(p.startKey).getTime() : now));
      var end = due - S.FINISH_HOURS_BEFORE_DUE * HOUR;
      if (end <= start) end = due - HOUR;            // late: use whatever is left
      var byDay = {};
      subtract_(dailyWindows_(start, end), busy).forEach(function (f) {
        var s = ceil15_(f[0]);
        if ((f[1] - s) / MIN >= S.MIN_BLOCK_MINUTES) (byDay[dayKey_(new Date(s))] = byDay[dayKey_(new Date(s))] || []).push([s, f[1]]);
      });
      var days = Object.keys(byDay).sort(), perDay = {};
      // Even-sized blocks that add up exactly (8h -> 6 x 80min, not 5 x 90 + a stray 45).
      var size = Math.max(S.MIN_BLOCK_MINUTES, Math.ceil(need / Math.ceil(need / S.BLOCK_MINUTES) / 5) * 5);
      // Round-robin across days: spreads the work out, front-loaded, instead of cramming.
      while (need > 0) {
        var progressed = false;
        for (var i = 0; i < days.length && need > 0; i++) {
          var d = days[i];
          var cap = Math.min(itemCap - (perDay[d] || 0), totalCap - (dayLoad[d] || 0));
          var want = Math.min(size, Math.max(need, S.MIN_BLOCK_MINUTES), cap);
          if (want < S.MIN_BLOCK_MINUTES) continue;
          var slots = byDay[d], pick = -1, j;
          for (j = 0; j < slots.length; j++) if ((slots[j][1] - slots[j][0]) / MIN >= want) { pick = j; break; }
          if (pick < 0) {
            var best = -1;
            for (j = 0; j < slots.length; j++) if (best < 0 || slots[j][1] - slots[j][0] > slots[best][1] - slots[best][0]) best = j;
            if (best < 0) continue;
            want = Math.min(want, Math.floor((slots[best][1] - slots[best][0]) / MIN / 15) * 15);
            if (want < S.MIN_BLOCK_MINUTES) continue;
            pick = best;
          }
          var bs = slots[pick][0], be = bs + want * MIN;
          p.create.push([bs, be]);
          busy = merge_(busy.concat([[bs - buf, be + buf]]));
          slots[pick] = [ceil15_(be + buf), slots[pick][1]];
          byDay[d] = slots.filter(function (x) { return (x[1] - x[0]) / MIN >= S.MIN_BLOCK_MINUTES; });
          perDay[d] = (perDay[d] || 0) + want;
          addLoad(bs, be);
          need -= want;
          progressed = true;
        }
        if (!progressed) break;
      }
    }
    p.planned = planned(p);
    p.shortfallMin = Math.max(0, tier.workMin - p.planned);
  });
  return plans;
}
