/**
 * Gradescope: no API, so log in with Gradescope's own email/password (not USC
 * SSO, which needs Duo) and read the student dashboard HTML. The only source
 * that reports submissions, so finished work drops off your calendar.
 */

var GS = 'https://www.gradescope.com';

// ---- tiny cookie jar (UrlFetchApp doesn't keep cookies) ----
function gsCookies_() { return storeGet_('gs_cookies', {}); }
function gsCookieHeader_(jar) { return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; '); }
function gsAbsorb_(jar, res) {
  var h = res.getAllHeaders()['Set-Cookie'];
  if (!h) return;
  (Array.isArray(h) ? h : [h]).forEach(function (c) {
    var kv = c.split(';')[0], i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
}

function gsFetch_(jar, path, opts) {
  opts = opts || {};
  var res = UrlFetchApp.fetch(GS + path, {
    method: opts.method || 'get', payload: opts.payload, followRedirects: false, muteHttpExceptions: true,
    headers: { Cookie: gsCookieHeader_(jar), 'User-Agent': 'Mozilla/5.0 (Macintosh) duesync' }
  });
  gsAbsorb_(jar, res);
  var code = res.getResponseCode();
  if ((code === 301 || code === 302) && opts.follow !== false) {
    var loc = res.getAllHeaders()['Location'] || '';
    if (/\/login/.test(loc)) return { code: 401, text: '', loc: loc };
    return gsFetch_(jar, loc.replace(GS, ''), {});
  }
  return { code: code, text: res.getContentText(), loc: res.getAllHeaders()['Location'] };
}

function gsLogin_() {
  var email = secret_('GS_EMAIL'), pw = secret_('GS_PASSWORD');
  if (!email || !pw) throw new Error('GS_EMAIL / GS_PASSWORD not set in Script Properties');
  var jar = {};
  var page = gsFetch_(jar, '/login');
  var tok = /name="authenticity_token"\s+value="([^"]+)"/.exec(page.text) || /value="([^"]+)"\s+name="authenticity_token"/.exec(page.text);
  if (!tok) throw new Error('Gradescope login page changed (no authenticity_token)');
  var res = gsFetch_(jar, '/login', {
    method: 'post', follow: false,
    payload: { utf8: '✓', 'session[email]': email, 'session[password]': pw, 'session[remember_me]': '1',
               commit: 'Log In', authenticity_token: decodeEntities_(tok[1]) }
  });
  if (res.code !== 302 || /\/login/.test(res.loc || '')) throw new GsAuthError_('Gradescope rejected GS_EMAIL / GS_PASSWORD');
  storeSet_('gs_cookies', jar);
  return jar;
}

function GsAuthError_(msg) { this.message = msg; this.name = 'GsAuthError'; }
GsAuthError_.prototype = Object.create(Error.prototype);

function gsGet_(jar, path) {
  var r = gsFetch_(jar, path);
  if (r.code === 401 || r.code === 403 || /<form[^>]+action="\/login"/.test(r.text)) return null;
  if (r.code !== 200) throw new Error('Gradescope HTTP ' + r.code + ' for ' + path);
  return r.text;
}

/** Fetch with saved cookies; on expiry log in once and retry. */
function gsGetAuthed_(state, path) {
  state.jar = state.jar || gsCookies_();
  var html = Object.keys(state.jar).length ? gsGet_(state.jar, path) : null;
  if (html === null) {
    state.jar = gsLogin_();
    html = gsGet_(state.jar, path);
    if (html === null) throw new GsAuthError_('Gradescope login did not stick');
  }
  return html;
}

function gsParseCourses_(html) {
  // Walk the account page in order, tracking which term heading each course box sits under.
  var re = /class="courseList--term[^"]*"[^>]*>([\s\S]*?)<\/|<a[^>]+class="courseBox[^"]*"[^>]*href="\/courses\/(\d+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]+href="\/courses\/(\d+)"[^>]+class="courseBox[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  var m, term = '', out = [];
  while ((m = re.exec(html))) {
    if (m[1] != null) { term = stripTags_(m[1]); continue; }
    var id = m[2] || m[4], inner = m[3] || m[5];
    var short = /courseBox--shortname[^>]*>([\s\S]*?)</.exec(inner), full = /courseBox--name[^>]*>([\s\S]*?)</.exec(inner);
    out.push({ id: id, short: short ? stripTags_(short[1]) : '', full: full ? stripTags_(full[1]) : '', term: term });
  }
  return out;
}

function gsTime_(s) {   // "2026-11-06 23:59:00 -0800" -> Date
  var m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})/.exec(s);
  return m ? new Date(m[1] + 'T' + m[2] + m[3] + ':' + m[4]) : new Date(s);
}

function gsParseAssignments_(html) {
  var table = (/<table[^>]*id="assignments-student-table"[\s\S]*?<\/table>/.exec(html) || [html])[0];
  var body = (/<tbody[\s\S]*?<\/tbody>/.exec(table) || [table])[0];
  var rows = body.split(/<tr\b/).slice(1), out = [];
  rows.forEach(function (row) {
    var th = /<th[^>]*>([\s\S]*?)<\/th>/.exec(row);
    if (!th) return;
    var link = /href="\/courses\/\d+\/assignments\/(\d+)/.exec(th[1]);
    var btn = /data-assignment-id="(\d+)"/.exec(th[1]);
    var statusM = /<td[^>]*class="[^"]*submissionStatus[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(row) || /<td[^>]*>([\s\S]*?)<\/td>/.exec(row);
    var status = statusM ? stripTags_(statusM[1]) : '';
    var pts = /([\d.]+)\s*\/\s*([\d.]+)/.exec(status);
    var dues = [], tm, tre = /<time[^>]*submissionTimeChart--dueDate[^>]*>/g;
    while ((tm = tre.exec(row))) { var dt = /datetime="([^"]+)"/.exec(tm[0]); if (dt) dues.push(gsTime_(dt[1])); }
    out.push({
      id: link ? link[1] : (btn ? btn[1] : null), name: stripTags_(th[1]), status: status,
      submitted: !!link || !!pts || /^submitted/i.test(status),
      due: dues[0] || null, lateDue: dues[1] || null, max: pts ? parseFloat(pts[2]) : null
    });
  });
  return out;
}

function fetchGradescope_() {
  if (!secret_('GS_EMAIL')) return null;   // not configured
  var st = {};
  var courses = gsParseCourses_(gsGetAuthed_(st, '/account'));
  if (!courses.length) return [];
  var term = courses[0].term;              // newest term is listed first
  var items = [];
  courses.filter(function (c) { return c.term === term; }).forEach(function (c) {
    var label = courseLabel_(c.short, c.full) || c.short;
    gsParseAssignments_(gsGetAuthed_(st, '/courses/' + c.id)).forEach(function (a) {
      if (!a.due) return;
      items.push({
        uid: 'gs:' + c.id + ':' + (a.id || stableId_(a.name)), source: 'gradescope', course: label, title: a.name,
        due: a.due, url: GS + '/courses/' + c.id + (a.id ? '/assignments/' + a.id : ''), points: a.max,
        submitted: a.submitted, extra: { late_due: a.lateDue ? iso_(a.lateDue) : null, status: a.status }
      });
    });
  });
  storeSet_('gs_cookies', st.jar);
  return items;
}
