/**
 * Brightspace: the official per-user calendar feed (Calendar > Subscribe).
 * No login, never expires with your SSO session. It doesn't know whether you
 * submitted, so Brightspace items are marked done by renaming the event to ✅.
 */

var BS_SUFFIX = /\s*[-–:]\s*(due|availability ends|end date|ends|end)\s*$/i;
var BS_INCLUDE = /\b(due|ends?|end date)\b|midterm|exam|final/i;
var BS_EXCLUDE = /availability (starts|begins)|start date|\bopens?\b|\bavailable\b/i;

function fetchBrightspace_() {
  var url = secret_('BRIGHTSPACE_ICS_URL');
  if (!url) return null;   // not configured
  var res = UrlFetchApp.fetch(url.replace(/^webcal:/, 'https:'), { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('Brightspace feed HTTP ' + res.getResponseCode());
  return parseIcs_(res.getContentText());
}

function icsUnescape_(s) {
  return String(s).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** ICS date -> Date. Handles UTC (Z), TZID/floating local times, and all-day dates (-> 11:59 PM). */
function icsDate_(value, params) {
  var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  if (!m[4] || /VALUE=DATE(?!-)/i.test(params)) return localDate_(+m[1], +m[2], +m[3], 23, 59);
  if (m[7]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return localDate_(+m[1], +m[2], +m[3], +m[4], +m[5]);   // TZID or floating: treat as local (USC = Pacific)
}

function parseIcs_(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  var items = [], ev = null;
  lines.forEach(function (line) {
    if (line === 'BEGIN:VEVENT') { ev = {}; return; }
    if (line === 'END:VEVENT') { if (ev) items.push(ev); ev = null; return; }
    if (!ev) return;
    var i = line.indexOf(':');
    if (i < 0) return;
    var head = line.slice(0, i), val = line.slice(i + 1);
    var name = head.split(';')[0].toUpperCase();
    ev[name] = { value: val, params: head };
  });
  var out = [];
  items.forEach(function (e) {
    var summary = e.SUMMARY ? icsUnescape_(e.SUMMARY.value).trim() : '';
    if (!summary || !BS_INCLUDE.test(summary) || BS_EXCLUDE.test(summary) || !e.DTSTART) return;
    var due = icsDate_(e.DTSTART.value, e.DTSTART.params);
    if (!due) return;
    var location = e.LOCATION ? icsUnescape_(e.LOCATION.value) : '';
    var desc = e.DESCRIPTION ? icsUnescape_(e.DESCRIPTION.value) : '';
    var url = e.URL ? e.URL.value : ((/https?:\/\/\S+/.exec(desc) || [])[0] || null);
    var uidRaw = e.UID ? e.UID.value : stableId_(summary, iso_(due));
    out.push({
      uid: 'bs:' + uidRaw, source: 'brightspace', title: summary.replace(BS_SUFFIX, '').replace(/\s+due\s+[A-Z][a-z]{2}\.?\s+\d{1,2}$/i, ''),
      course: courseLabel_(location, summary, desc), due: due, url: url, submitted: false, extra: {}
    });
  });
  return out;
}
