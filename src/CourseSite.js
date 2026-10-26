/**
 * Public course websites (currently CS 103's bytes.usc.edu page). No login.
 * Table rows like "HW3 | Classes | Friday, Oct. 30th" or "Ex3 | Thursday,
 * November 19th | (in class)" become items. Re-read every few hours so new
 * assignments and moved dates show up. Codio can't report submissions, so
 * mark these done by renaming the deadline event to start with ✅.
 */

var MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** HTML -> lines with table cells separated by tabs. */
function siteRows_(html) {
  return decodeEntities_(String(html)
    .replace(/<!--[\s\S]*?-->/g, '')            // hidden/commented-out columns
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+/g, ' ')                       // source line breaks mean nothing; structure comes from tags
    .replace(/<\/t[dh]>/gi, '\t').replace(/<\/tr>|<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .split('\n').map(function (l) { return l.replace(/[  ]+/g, ' ').replace(/ *\t */g, '\t').trim(); })
    .filter(Boolean);
}

/** "Friday, Oct. 30th" / "Saturday, December 12 11am - 1pm" -> {month, day, h, m} or null */
function siteDate_(s) {
  var m = /(?:[a-z]+day,?\s*)?\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i.exec(s);
  if (!m) return null;
  var mon = MONTHS_[m[1].toLowerCase().slice(0, 4)] || MONTHS_[m[1].toLowerCase().slice(0, 3)];
  if (!mon) return null;
  var h = null, mi = 0;
  if (m[3]) { h = parseInt(m[3], 10) % 12 + (m[5].toLowerCase() === 'pm' ? 12 : 0); mi = m[4] ? parseInt(m[4], 10) : 0; }
  return { month: mon, day: parseInt(m[2], 10), h: h, m: mi };
}

function parseCourseSite_(html, site) {
  var items = [], exams = {};
  var hm = function (s) { var p = s.split(':'); return [parseInt(p[0], 10), parseInt(p[1], 10)]; };
  var due = hm(site.DUE_TIME), examT = hm(site.EXAM_TIME);
  siteRows_(html).forEach(function (line) {
    var cells = line.split('\t').map(function (c) { return c.replace(/^[^A-Za-z0-9(]+/, '').trim(); }).filter(Boolean);
    if (cells.length < 2) return;
    var code = cells[0];
    var hw = /^(HW|PR|PA|Lab)\s*(\d+)$/i.exec(code), ex = /^(Ex|Exam|Midterm)\s*(\d+)$|^(Final)(?: Exam)?$/i.exec(code);
    if (!hw && !ex) return;
    var dateCell = cells.slice(1).filter(function (c) { return siteDate_(c); })[0];
    if (!dateCell) return;
    var d = siteDate_(dateCell);
    if (hw) {
      var titleCell = cells[1] === dateCell ? '' : cells[1];
      var tag = hw[1].toUpperCase() + hw[2];
      items.push({ code: tag, title: tag + (titleCell ? ': ' + titleCell : ''),
                   due: localDate_(site.YEAR, d.month, d.day, d.h != null ? d.h : due[0], d.h != null ? d.m : due[1]) });
    } else {
      var n = ex[2], title = n ? 'Exam ' + n : 'Final Exam';
      var when = localDate_(site.YEAR, d.month, d.day, d.h != null ? d.h : examT[0], d.h != null ? d.m : examT[1]);
      exams[n || 'final'] = when;
      items.push({ code: n ? 'EX' + n : 'FINAL', title: title, due: when });
    }
  });
  // Projects close for late submission at 12am the morning of their paired exam.
  return items.map(function (x) {
    var pr = /^PR(\d+)$/.exec(x.code), late = pr && exams[pr[1]];
    return {
      uid: 'by:' + site.KEY + ':' + x.code, source: 'coursesite', course: site.COURSE, title: x.title, due: x.due,
      url: site.URL, submitted: false,
      extra: late ? { late_due: iso_(localDate_(site.YEAR, +fmt_(late, 'M'), +fmt_(late, 'd'), 0, 0)) } : {}
    };
  });
}

function fetchCourseSites_() {
  var sites = CONFIG.COURSE_SITES || [];
  if (!sites.length) return null;
  var out = [];
  sites.forEach(function (site) {
    var res = UrlFetchApp.fetch(site.URL, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) throw new Error(site.COURSE + ' site HTTP ' + res.getResponseCode() + ' (' + site.URL + ')');
    var got = parseCourseSite_(res.getContentText(), site);
    if (!got.length) throw new Error(site.COURSE + ' site: no assignments found at ' + site.URL + ' (page layout changed?)');
    out = out.concat(got);
  });
  return out;
}

/** Logs what the page looks like to the parser (for fixing it if the layout changes). */
function debugCourseSite() {
  var site = CONFIG.COURSE_SITES[0];
  var html = UrlFetchApp.fetch(site.URL, { muteHttpExceptions: true, followRedirects: true }).getContentText();
  console.log('HTML length ' + html.length + '; <table> tags: ' + (html.match(/<table/gi) || []).length);
  siteRows_(html).filter(function (l) { return /HW|PR|Ex|Final|Due/i.test(l); }).slice(0, 25)
    .forEach(function (l) { console.log(JSON.stringify(l)); });
}
