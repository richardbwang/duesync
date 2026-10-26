// Loads the Apps Script sources into a Node vm context with fake Google services.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function formatDate(date, tz, pattern) {
  const d = new Date(date);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'short', hourCycle: 'h23', timeZoneName: 'longOffset'
  }).formatToParts(d).map(p => [p.type, p.value]));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const longDays = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
  const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const off = (parts.timeZoneName.replace('GMT', '') || '+00:00').replace(':', '');
  const H = +parts.hour, h12 = ((H + 11) % 12) + 1;
  const tok = {
    yyyy: parts.year, MMM: months[+parts.month - 1], MM: parts.month, M: String(+parts.month),
    dd: parts.day, d: String(+parts.day), HH: parts.hour, hh: String(h12).padStart(2, '0'), h: String(h12),
    mm: parts.minute, a: H < 12 ? 'AM' : 'PM', EEEE: longDays[parts.weekday], EEE: parts.weekday, u: String(u), Z: off
  };
  return pattern.replace(/yyyy|MMM|MM|M|dd|d|HH|hh|h|mm|a|EEEE|EEE|u|Z/g, m => tok[m]);
}

function load() {
  const props = {};
  const ctx = {
    console: { log: () => {} },
    Utilities: {
      formatDate,
      computeDigest: (_alg, s) => Array.from(crypto.createHash('sha1').update(s).digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_1: 'sha1' }, Charset: { UTF_8: 'utf8' }, sleep: () => {}
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      setProperties: o => Object.assign(props, o),
      deleteProperty: k => { delete props[k]; }
    }) },
    MailApp: { sent: [], sendEmail(to, subj, body) { this.sent.push({ to, subj, body }); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    _props: props
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'src');
  for (const f of ['Config.js', 'Util.js', 'Store.js', 'Planner.js', 'CalendarSync.js', 'Brightspace.js', 'Gradescope.js', 'CourseSite.js', 'Email.js', 'Syllabus.js', 'Digest.js', 'Main.js', 'Setup.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  // Most tests exercise the block engine; tests for the default (off) set it explicitly.
  ctx.CONFIG.WORK_BLOCKS = true;
  return ctx;
}

class FakeCal {
  constructor() { this.events = {}; this.n = 0; this.busy = []; this.cals = {}; }
  ensure(name, known) { if (known) return known; this.cals[name] = this.cals[name] || 'cal-' + Object.keys(this.cals).length; return this.cals[name]; }
  list(calId) { return Object.values(this.events).filter(e => e.calId === calId && e.extendedProperties).map(e => JSON.parse(JSON.stringify(e))); }
  freebusy() { return this.busy.slice(); }
  overlapping(calId, tmin, tmax) {
    return Object.values(this.events).filter(e => e.calId === calId && e.start.dateTime &&
      new Date(e.start.dateTime) < tmax && new Date(e.end.dateTime) > tmin);
  }
  insert(calId, body) { const id = 'e' + (++this.n); this.events[id] = { ...JSON.parse(JSON.stringify(body)), id, calId, status: 'confirmed' }; return this.events[id]; }
  patch(calId, id, body) { Object.assign(this.events[id], JSON.parse(JSON.stringify(body))); return this.events[id]; }
  remove(calId, id) { this.events[id].status = 'cancelled'; }
  live(kind, calId) {
    return Object.values(this.events).filter(e => e.status !== 'cancelled' && (!calId || e.calId === calId) &&
      (!kind || (e.extendedProperties && e.extendedProperties.private.kind === kind)));
  }
}

module.exports = { load, FakeCal, formatDate };
