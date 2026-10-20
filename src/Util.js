/** Time-zone, text and id helpers shared by every file. */

var MIN = 60 * 1000;
var HOUR = 60 * MIN;
var DAY = 24 * HOUR;

/** "3d" / "2h" / "30m" / "1w" -> minutes */
function minutes_(spec) {
  if (typeof spec === 'number') return spec;
  var m = /^\s*(\d+(?:\.\d+)?)\s*([wdhm])\s*$/.exec(String(spec));
  if (!m) throw new Error('bad duration ' + spec + ' (use 7d, 3h, 30m)');
  return Math.round(parseFloat(m[1]) * { w: 10080, d: 1440, h: 60, m: 1 }[m[2]]);
}

function fmt_(date, pattern) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, pattern);
}

/** UTC offset in minutes of CONFIG.TIMEZONE at that instant (e.g. -420 for PDT). */
function tzOffset_(date) {
  var z = fmt_(date, 'Z');
  var sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
}

/** Date for a wall-clock time in CONFIG.TIMEZONE. month is 1-12. */
function localDate_(y, mo, d, h, mi) {
  var guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  var off = tzOffset_(new Date(guess));
  var t = guess - off * MIN;
  var off2 = tzOffset_(new Date(t));
  if (off2 !== off) t = guess - off2 * MIN;
  return new Date(t);
}

/** "yyyy-MM-dd" in CONFIG.TIMEZONE */
function dayKey_(date) { return fmt_(date, 'yyyy-MM-dd'); }

function dayStart_(key) {
  var p = key.split('-');
  return localDate_(+p[0], +p[1], +p[2], 0, 0);
}

function addDaysKey_(key, n) {
  var p = key.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

/** 1 = Monday ... 7 = Sunday */
function weekday_(key) { return parseInt(fmt_(dayStart_(key), 'u'), 10); }

function iso_(date) { return new Date(date).toISOString(); }

function prettyDate_(date) { return fmt_(date, 'EEE MMM d, h:mm a'); }

/** Pull "CSCI 103" out of whatever text a platform gives. */
function courseLabel_() {
  var blob = Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
  for (var pat in CONFIG.COURSE_ALIASES) {
    if (new RegExp(pat, 'i').test(blob)) return CONFIG.COURSE_ALIASES[pat];
  }
  var m = /\b([A-Z]{2,5})[\s\-_]?(\d{3})[A-Za-z]{0,2}\b/.exec(blob);
  return m ? m[1] + ' ' + m[2] : '';
}

function stableId_() {
  var s = Array.prototype.slice.call(arguments).join('|');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s, Utilities.Charset.UTF_8);
  return bytes.slice(0, 6).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

var STOP_WORDS_ = { the: 1, a: 1, an: 1, of: 1, and: 1, due: 1, assignment: 1, submission: 1, ends: 1, end: 1 };
function titleWords_(s) {
  var out = {};
  (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function (w) { if (!STOP_WORDS_[w]) out[w] = 1; });
  return out;
}

function similarity_(a, b) {
  var wa = titleWords_(a), wb = titleWords_(b), inter = 0, uni = 0, k;
  for (k in wa) { uni++; if (wb[k]) inter++; }
  for (k in wb) if (!wa[k]) uni++;
  return uni ? inter / uni : 0;
}

function itemLabel_(it) { return it.course ? it.course + ' · ' + it.title : it.title; }

function decodeEntities_(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); });
}

function stripTags_(html) {
  return decodeEntities_(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
