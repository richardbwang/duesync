const test = require('node:test');
const assert = require('node:assert');
const { load, FakeCal, formatDate } = require('./harness');

const TZ = 'America/Los_Angeles';
const at = (ds, hm = '23:59') => new Date(`${ds}T${hm}:00${new Date(`${ds}T12:00:00Z`) >= new Date('2026-11-01T09:00:00Z') ? '-08:00' : '-07:00'}`);
const NOW = at('2026-10-19', '16:00').getTime();   // Monday
const mk = (uid, title, due, o = {}) => ({ uid, source: o.source || 'gradescope', course: o.course ?? 'CSCI 103', title, due, url: null,
  points: o.points ?? null, submitted: !!o.submitted, extra: {} });

test('tz helpers', () => {
  const g = load();
  assert.equal(g.localDate_(2026, 10, 22, 23, 59).toISOString(), '2026-10-23T06:59:00.000Z');
  assert.equal(g.localDate_(2026, 11, 6, 23, 59).toISOString(), '2026-11-07T07:59:00.000Z'); // after DST ends
  assert.equal(g.weekday_('2026-10-19'), 1);
  assert.equal(g.addDaysKey_('2026-10-31', 1), '2026-11-01');
  assert.equal(formatDate(new Date(NOW), TZ, 'EEE MM/dd h:mma'), 'Mon 10/19 4:00PM');
});

test('brightspace ics', () => {
  const g = load();
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:6606-1234@brightspace.usc.edu', 'SUMMARY:Reading Response 8 - Due',
    'LOCATION:GESM 120g: Jews and Muslims (Fall 2026)', 'DTSTART:20261023T065900Z', 'DESCRIPTION:View https://brightspace.us',
    ' c.edu/d2l/le/calendar/1234', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:x2', 'SUMMARY:Quiz 4 - Availability Starts', 'DTSTART:20261020T160000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:x3', 'SUMMARY:Midterm 2', 'LOCATION:CSCI 170: Discrete Methods', 'DTSTART;VALUE=DATE:20261105', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:x4', 'SUMMARY:HW 6 - Due', 'LOCATION:MATH 229', 'DTSTART;TZID=America/Los_Angeles:20261030T235900', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const items = g.parseIcs_(ics);
  assert.deepEqual(items.map(i => i.title), ['Reading Response 8', 'Midterm 2', 'HW 6']);
  assert.equal(items[0].course, 'GESM 120');
  assert.equal(items[0].due.toISOString(), '2026-10-23T06:59:00.000Z');
  assert.equal(items[0].url, 'https://brightspace.usc.edu/d2l/le/calendar/1234');
  assert.equal(items[1].due.toISOString(), '2026-11-06T07:59:00.000Z');   // all-day -> 11:59pm PST
  assert.equal(items[2].due.toISOString(), '2026-10-31T06:59:00.000Z');
});

test('gradescope parsers', () => {
  const g = load();
  const account = `<div id="account-show"><div class="courseList"><div class="courseList--term">Fall 2026</div>
    <div class="courseList--coursesForTerm"><a class="courseBox" href="/courses/111"><h3 class="courseBox--shortname">CSCI 103L</h3>
    <div class="courseBox--name">Introduction to Programming</div></a>
    <a href="/courses/222" class="courseBox"><h3 class="courseBox--shortname">MATH 229</h3><div class="courseBox--name">Calc III</div></a></div>
    <div class="courseList--term">Spring 2026</div><a class="courseBox" href="/courses/9"><h3 class="courseBox--shortname">OLD 101</h3></a></div></div>`;
  const cs = g.gsParseCourses_(account);
  assert.deepEqual(cs.map(c => [c.id, c.term]), [['111', 'Fall 2026'], ['222', 'Fall 2026'], ['9', 'Spring 2026']]);
  assert.equal(cs[0].short, 'CSCI 103L');
  const course = `<table id="assignments-student-table"><thead><tr><th>Name</th></tr></thead><tbody>
    <tr role="row"><th class="table--primaryLink"><a href="/courses/111/assignments/501/submissions/9">PA3: Connect 4</a></th>
     <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td>
     <td><time class="submissionTimeChart--dueDate" datetime="2026-10-10 23:59:00 -0700">Oct 10</time></td></tr>
    <tr role="row"><th class="table--primaryLink"><button class="js-submitAssignment" data-assignment-id="502">PA4: Pixel &amp; Art</button></th>
     <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
     <td><time class="submissionTimeChart--releaseDate" datetime="2026-10-15 00:00:00 -0700"></time>
     <time datetime="2026-11-06 23:59:00 -0800" class="submissionTimeChart--dueDate">Nov 6</time>
     <time class="submissionTimeChart--dueDate" datetime="2026-11-08 23:59:00 -0800">Late</time></td></tr>
    <tr role="row"><th><a href="/courses/111/assignments/503/submissions/2">HW 5</a></th><td class="submissionStatus">8.0 / 10.0</td><td></td></tr>
    </tbody></table>`;
  const rows = g.gsParseAssignments_(course);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].submitted && rows[0].id === '501');
  assert.ok(!rows[1].submitted && rows[1].id === '502' && rows[1].name === 'PA4: Pixel & Art');
  assert.equal(rows[1].due.toISOString(), '2026-11-07T07:59:00.000Z');
  assert.equal(rows[1].lateDue.toISOString(), '2026-11-09T07:59:00.000Z');
  assert.ok(rows[2].submitted && rows[2].max === 10 && rows[2].due === null);
  assert.equal(g.courseLabel_('CSCI 103L', 'Intro'), 'CSCI 103');
});

test('gradescope login flow with cookies', () => {
  const g = load();
  g._props.GS_EMAIL = 'me@usc.edu'; g._props.GS_PASSWORD = 'pw';
  const calls = [];
  const resp = (code, text, headers = {}) => ({ getResponseCode: () => code, getContentText: () => text, getAllHeaders: () => headers });
  g.UrlFetchApp = { fetch(url, o) {
    calls.push([o.method, url.replace('https://www.gradescope.com', ''), o.headers.Cookie]);
    const path = url.replace('https://www.gradescope.com', '');
    if (path === '/login' && o.method === 'get') return resp(200, '<input type="hidden" name="authenticity_token" value="T&amp;K">', { 'Set-Cookie': '_gradescope_session=s1; path=/' });
    if (path === '/login') { assert.equal(o.payload.authenticity_token, 'T&K'); return resp(302, '', { Location: 'https://www.gradescope.com/account', 'Set-Cookie': ['signed_token=tok; path=/', 'remember_me=r; path=/'] }); }
    if (!/signed_token=tok/.test(o.headers.Cookie || '')) return resp(302, '', { Location: 'https://www.gradescope.com/login' });
    if (path === '/account') return resp(200, '<div class="courseList--term">Fall 2026</div><a class="courseBox" href="/courses/111"><h3 class="courseBox--shortname">CSCI 103</h3></a>');
    return resp(200, '<table id="assignments-student-table"><tbody><tr><th><button data-assignment-id="7">PA5</button></th><td class="submissionStatus">No Submission</td><td><time class="submissionTimeChart--dueDate" datetime="2026-11-20 23:59:00 -0800"></time></td></tr></tbody></table>');
  } };
  const items = g.fetchGradescope_();
  assert.equal(items.length, 1);
  assert.equal(items[0].uid, 'gs:111:7');
  assert.equal(calls.filter(c => c[1] === '/login').length, 2);   // one login (GET + POST) only
  // Second run reuses saved cookies: no login.
  calls.length = 0;
  g.fetchGradescope_();
  assert.equal(calls.filter(c => c[1] === '/login').length, 0);
  // Wrong password -> GsAuthError
  g._props.ds_gs_cookies_0 = '{}';
  g.UrlFetchApp.fetch = (url, o) => url.endsWith('/login') && o.method === 'get'
    ? resp(200, 'name="authenticity_token" value="x"') : resp(200, 'Invalid email/password');
  assert.throws(() => g.fetchGradescope_(), e => e.name === 'GsAuthError');
});

test('classify + dedupe', () => {
  const g = load();
  assert.equal(g.classify_(mk('1', 'PA4: Pixel Art', at('2026-10-30'))).name, 'big');
  assert.equal(g.classify_(mk('2', 'HW 6', at('2026-10-30'), { course: 'CSCI 170' })).name, 'medium');
  assert.equal(g.classify_(mk('3', 'Reading Response 8', at('2026-10-30'), { course: 'GESM 120' })).name, 'small');
  const t = g.classify_(mk('4', 'Midterm 2', at('2026-11-05'), { course: 'CSCI 170' }));
  assert.equal(t.label, 'Study'); assert.equal(t.workMin, 480);
  assert.deepEqual(Array.from(g.classify_(mk('5', 'Project', at('2026-11-05'))).reminders), [20160, 10080, 4320, 1440, 180]);
  const out = g.dedupe_([mk('bs:1', 'PA4 - Pixel Art', at('2026-11-06', '23:00'), { source: 'brightspace' }), mk('gs:1', 'PA4: Pixel Art', at('2026-11-06'))]);
  assert.equal(out.length, 1); assert.equal(out[0].source, 'gradescope'); assert.deepEqual(Array.from(out[0].extra.also_on), ['brightspace']);
});

test('planner avoids busy time, spreads, respects windows', () => {
  const g = load();
  const proj = mk('gs:p', 'PA4: Pixel Art', at('2026-11-06'));
  const busy = [[at('2026-10-28', '10:00').getTime(), at('2026-10-28', '16:00').getTime()]];
  const p = g.planAll_([proj], {}, busy, [], NOW)[0];
  assert.equal(p.planned, 720); assert.equal(p.shortfallMin, 0);
  const startDay = at('2026-10-27', '00:00').getTime(), lastEnd = proj.due.getTime() - 12 * 3600e3;
  for (const [s, e] of p.create) {
    assert.ok(s >= startDay && e <= lastEnd);
    assert.ok(!(s < busy[0][1] + 600e3 && e > busy[0][0] - 600e3), 'overlaps busy+buffer');
    const hh = +formatDate(new Date(s), TZ, 'HH'), eh = +formatDate(new Date(e), TZ, 'HH');
    assert.ok(hh >= 10 && (eh < 23 || (eh === 23 && +formatDate(new Date(e), TZ, 'mm') === 0)));
  }
  assert.ok(new Set(p.create.map(([s]) => formatDate(new Date(s), TZ, 'yyyy-MM-dd'))).size >= 6);
});

test('shortfall when calendar is full', () => {
  const g = load();
  const hw = mk('gs:h', 'HW 6', at('2026-10-21'), { course: 'CSCI 170' });
  const p = g.planAll_([hw], {}, [[at('2026-10-19', '00:00').getTime(), at('2026-10-21', '23:59').getTime()]], [], NOW)[0];
  assert.equal(p.planned, 0); assert.equal(p.shortfallMin, 180);
});

test('reconcile end to end', () => {
  const g = load(), cal = new FakeCal(), state = {};
  const items = (sub = false) => [mk('gs:111:502', 'PA4: Pixel Art', at('2026-11-06'), { submitted: sub }),
    mk('bs:rr8', 'Reading Response 8', at('2026-10-22'), { course: 'GESM 120', source: 'brightspace' })];
  g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.equal(cal.live('due').length, 2); assert.equal(cal.live('start').length, 1); assert.equal(cal.live('block').length, 8);
  const pa = cal.live('due').find(e => /PA4/.test(e.summary));
  assert.deepEqual(pa.reminders.overrides.map(o => o.minutes), [20160, 10080, 4320, 1440, 180]);

  let r = g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.deepEqual([r.created, r.updated, r.deleted], [0, 0, 0], 'second run must not churn');

  const blk = cal.live('block').sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))[2];
  cal.busy = [[new Date(blk.start.dateTime).getTime(), new Date(blk.end.dateTime).getTime()]];
  r = g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.deepEqual([r.deleted, r.created], [1, 1]); assert.equal(cal.live('block').length, 8);

  const victim = cal.live('block')[0];
  cal.events[victim.id].status = 'cancelled';
  g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.ok(cal.live('block').every(e => e.start.dateTime !== victim.start.dateTime));
  assert.equal(cal.live('block').length, 8);

  r = g.reconcile_(cal, items().filter(i => i.source === 'brightspace'), { gradescope: true }, NOW, state, false);
  assert.equal(r.deleted, 0); assert.equal(cal.live('block').length, 8);

  g.reconcile_(cal, items(true), {}, NOW, state, false);
  assert.equal(cal.live('block').length, 0); assert.equal(cal.live('start').length, 0);
  assert.ok(cal.live('due').some(e => e.summary.startsWith('✅')));

  const rr = cal.live('due').find(e => /Reading/.test(e.summary));
  cal.events[rr.id].summary = '✅ ' + rr.summary;
  g.reconcile_(cal, items(true), {}, NOW, state, false);
  assert.deepEqual(cal.events[rr.id].reminders.overrides, []);
  cal.events[rr.id].status = 'cancelled';
  g.reconcile_(cal, items(true), {}, NOW, state, false);
  assert.ok(state.dismissed.includes('bs:rr8')); assert.equal(cal.events[rr.id].status, 'cancelled');
});

test('email: receipts, extraction, events, idempotency', () => {
  const g = load(), cal = new FakeCal(), state = {};
  let marked = 0, addedMarks = 0;
  const threads = [
    { link: 'L1', messages: [{ id: 'm1', from: 'no-reply@gradescope.com', subject: 'Successfully submitted to PA4', date: 'x', body: 'You submitted' }] },
    { link: 'L2', messages: [{ id: 'm2', from: 'prof@usc.edu', subject: 'Midterm 2 on Nov 5', date: 'x', body: 'Midterm 2 is Thursday Nov 5 at 2pm. Also the Viterbi career fair is Oct 28 at 11am.' }] },
    { link: 'L3', messages: [{ id: 'm3', from: 'news@usc.edu', subject: 'Weekly newsletter', date: 'x', body: 'Nothing here really' }] }
  ];
  const gmail = { threads: () => threads, markDone: (t, added) => { marked++; if (added) addedMarks++; } };
  let llm = 0;
  const extract = () => { llm++; return [
    { kind: 'exam', title: 'Midterm 2', course: 'CSCI 170', start: '2026-11-05T14:00:00-08:00', commitment: 'required' },
    { kind: 'event', title: 'Viterbi Career Fair', course: '', start: '2026-10-28T11:00:00-07:00', end: '2026-10-28T15:00:00-07:00', commitment: 'optional', reason: 'career fair' },
    { kind: 'event', title: 'Old thing', course: '', start: '2026-10-01T11:00:00-07:00', commitment: 'required' }
  ]; };
  const out = g.scanEmail_(gmail, state, NOW, extract);
  out.toLabel.forEach(t => gmail.markDone(t.thread, t.added));
  assert.equal(out.gsReceipt, true); assert.equal(llm, 1, 'newsletter skipped by prefilter? it mentions no date');
  assert.equal(out.newItems, 1); assert.equal(out.events.length, 1); assert.equal(marked, 3); assert.equal(addedMarks, 1);
  assert.equal(g.placeEvents_(cal, out.events, state, NOW, false), 1);
  const ev = cal.live('maybe')[0];
  assert.ok(ev.summary.startsWith('❔ Viterbi Career Fair')); assert.equal(ev.transparency, 'transparent');
  // Same messages again: nothing new, no LLM calls, no duplicate event.
  const again = g.scanEmail_(gmail, state, NOW, extract);
  assert.equal(llm, 1); assert.equal(again.newItems, 0);
  assert.equal(g.placeEvents_(cal, out.events, state, NOW, false), 0);
  // The exam from email gets study blocks via the planner.
  const items = g.unpackItems_(JSON.parse(JSON.stringify(state.emailItems)));
  const p = g.planAll_(items, {}, [], [], NOW)[0];
  assert.equal(p.tier.label, 'Study'); assert.equal(p.planned, 480);
});

test('runOnce: cadence, cache fallback, notifications', () => {
  const g = load(), cal = new FakeCal();
  g._props.BRIGHTSPACE_ICS_URL = 'x'; g._props.GS_EMAIL = 'x';
  let bsCalls = 0, gsMode = 'ok';
  const ctx = (now, extra = {}) => ({ cal, gmail: null, now, dryRun: false,
    fetchBrightspace: () => { bsCalls++; return [mk('bs:1', 'HW 6', at('2026-10-30'), { source: 'brightspace', course: 'MATH 229' })]; },
    fetchCourseSites: () => null,
    fetchGradescope: () => { if (gsMode === 'auth') { const e = new Error('bad'); e.name = 'GsAuthError'; throw e; } return [mk('gs:1:1', 'PA4: Pixel Art', at('2026-11-06'))]; },
    ...extra });
  let r = g.runOnce_(ctx(NOW));
  assert.equal(cal.live('due').length, 2);
  g.runOnce_(ctx(NOW + 10 * 60e3));
  assert.equal(bsCalls, 1, 'brightspace not refetched within 30 min');
  gsMode = 'auth';
  r = g.runOnce_(ctx(NOW + 61 * 60e3));
  assert.match(r.summary, /gradescope FAILED/);
  assert.equal(cal.live('due').length, 2, 'cached gradescope items kept');
  assert.equal(cal.live('block').length > 0, true);
  assert.equal(g.MailApp.sent.length, 1);
  g.runOnce_(ctx(NOW + 122 * 60e3));
  assert.equal(g.MailApp.sent.length, 1, 'notification throttled');
});

test('syllabus: extraction, dedupe against real listings, file changes', () => {
  const g = load(), state = {};
  const files = [{ id: 'f1', name: 'CSCI170_Syllabus_Fall2026.pdf', updated: 1, load: () => [1, 2, 3] }];
  const drive = { files: () => files };
  let calls = 0;
  const extract = () => { calls++; return { course: 'CSCI 170', items: [
    { kind: 'exam', title: 'Midterm 1', start: '2026-10-08T09:00:00-07:00' },                  // past -> skipped
    { kind: 'exam', title: 'Midterm 2', start: '2026-11-03T09:00:00-08:00', note: 'tentative' },
    { kind: 'exam', title: 'Final Exam', start: '2026-12-10T08:00:00-08:00' }] }; };
  let r = g.scanSyllabi_(drive, state, NOW, extract);
  assert.equal(r.processed, 1);
  let items = g.unpackItems_(JSON.parse(JSON.stringify(state.syllabusItems)));
  assert.deepEqual(items.map(i => i.title), ['Midterm 2', 'Final Exam']);
  assert.equal(items[0].course, 'CSCI 170');
  // Unchanged file: no new API call.
  g.scanSyllabi_(drive, state, NOW, extract); assert.equal(calls, 1);
  // Brightspace lists the real Midterm 2 two days later than the syllabus said -> one item, Brightspace wins.
  const bs = mk('bs:m2', 'Midterm 2', at('2026-11-05', '14:00'), { course: 'CSCI 170', source: 'brightspace' });
  const out = g.dedupe_(items.concat([bs]));
  assert.equal(out.length, 2);
  assert.equal(out.find(i => /Midterm/.test(i.title)).source, 'brightspace');
  // Midterm 1 vs Midterm 2 are not merged even when close.
  const m1 = mk('bs:m1', 'Midterm 1', at('2026-11-02', '14:00'), { course: 'CSCI 170', source: 'brightspace' });
  assert.equal(g.dedupe_([items[0], m1]).length, 2);
  // Edited file -> re-read and replace; deleted file -> its items go away.
  files[0].updated = 2;
  g.scanSyllabi_(drive, state, NOW, () => ({ course: 'CSCI 170', items: [{ kind: 'exam', title: 'Final Exam', start: '2026-12-11T08:00:00-08:00' }] }));
  assert.deepEqual(g.unpackItems_(JSON.parse(JSON.stringify(state.syllabusItems))).map(i => i.due.toISOString()), ['2026-12-11T16:00:00.000Z']);
  files.length = 0;
  g.scanSyllabi_(drive, state, NOW, extract);
  assert.equal(state.syllabusItems.length, 0);
  // Missing folder is reported, not an error.
  assert.equal(g.scanSyllabi_({ files: () => null }, {}, NOW, extract).missingFolder, true);
});

test('syllabus exam gets study blocks and a tentative note', () => {
  const g = load(), cal = new FakeCal(), state = {};
  const it = { uid: 'sy:x', source: 'syllabus', course: 'CSCI 170', title: 'Midterm 2', due: at('2026-11-03', '09:00'),
               url: 'https://drive.google.com/file/d/f1', submitted: false, extra: { file: 'f1', fileName: 'syl.pdf', note: 'in class' } };
  g.reconcile_(cal, [it], {}, NOW, state, false);
  const due = cal.live('due')[0];
  assert.match(due.description, /From syllabus "syl.pdf": tentative/);
  assert.ok(cal.live('block').every(b => b.summary.startsWith('📖 Study')));
  assert.ok(cal.live('block').length >= 5);
});

test('freebusy is chunked under Google\'s range limit', () => {
  const g = load();
  const calls = [];
  g.Calendar = { Freebusy: { query(body) {
    const span = new Date(body.timeMax) - new Date(body.timeMin);
    if (span > 90 * 864e5) throw new Error('The requested time range is too long.');
    calls.push(body);
    return { calendars: { primary: { busy: [{ start: body.timeMin, end: new Date(new Date(body.timeMin).getTime() + 3600e3).toISOString() }] } } };
  } } };
  const busy = g.googleCal_().freebusy(['primary'], new Date(NOW), new Date(NOW + 120 * 864e5));
  assert.equal(calls.length, 2); assert.equal(busy.length, 2);
});

test('calendar failure after scanning keeps scan progress and labels', () => {
  const g = load();
  g._props.ANTHROPIC_API_KEY = 'k';
  let labeled = 0, llm = 0;
  const gmail = { threads: () => [{ link: 'L', messages: [{ id: 'm1', from: 'p@usc.edu', subject: 'Quiz Friday', date: 'x', body: 'Quiz on Friday Oct 23' }] }],
                  markDone: () => { labeled++; } };
  const badCal = new FakeCal(); badCal.freebusy = () => { throw new Error('boom'); };
  const ctx = { cal: badCal, gmail, now: NOW, extract: () => { llm++; return []; }, fetchBrightspace: () => null, fetchGradescope: () => null, fetchCourseSites: () => null };
  assert.throws(() => g.runOnce_(ctx), /boom/);
  assert.equal(labeled, 1);
  assert.throws(() => g.runOnce_(ctx), /boom/);
  assert.equal(llm, 1, 'email not re-sent to Claude after a calendar crash');
});

test('first sync is spread over runs under the write cap, without duplicates', () => {
  const g = load(), cal = new FakeCal(), state = {};
  g.CONFIG.MAX_CALENDAR_WRITES_PER_RUN = 10;
  const items = [mk('gs:a', 'PA4: Pixel Art', at('2026-11-06')), mk('gs:b', 'Final Project', at('2026-11-20')), mk('gs:c', 'HW 7', at('2026-10-27'), { course: 'CSCI 170' })];
  let r, runs = 0;
  do { r = g.reconcile_(cal, items.map(i => ({ ...i, extra: {} })), {}, NOW, state, false); runs++; } while (r.deferred && runs < 20);
  assert.ok(runs > 1);
  const due = cal.live('due').map(e => e.extendedProperties.private.uid);
  assert.equal(new Set(due).size, due.length); assert.equal(due.length, 3);
  const mins = cal.live('block').reduce((a, e) => a + (new Date(e.end.dateTime) - new Date(e.start.dateTime)) / 60e3, 0);
  assert.equal(mins, (12 + 12 + 3) * 60);
  r = g.reconcile_(cal, items.map(i => ({ ...i, extra: {} })), {}, NOW, state, false);
  assert.deepEqual([r.created, r.updated, r.deleted, r.deferred], [0, 0, 0, 0]);
});

test('calendar writes back off on rate limit', () => {
  const g = load();
  let n = 0;
  const out = g.calWrite_(() => { if (++n < 3) throw new Error('Rate Limit Exceeded'); return 'ok'; });
  assert.equal(out, 'ok'); assert.equal(n, 3);
  assert.throws(() => g.calWrite_(() => { throw new Error('Not Found'); }), /Not Found/);
});

test('an email that keeps failing is given up after 3 runs', () => {
  const g = load(), state = {};
  const gmail = { threads: () => [{ link: 'L', messages: [{ id: 'bad', from: 'p@usc.edu', subject: 'Exam Friday', date: 'x', body: 'Exam Friday Oct 23' }] }], markDone: () => {} };
  let calls = 0;
  const extract = () => { calls++; throw new Error('Claude API 400: bad request'); };
  for (let i = 0; i < 5; i++) g.scanEmail_(gmail, state, NOW, extract);
  assert.equal(calls, 3);
});

test('writes stop when the run nears the 6-minute limit', () => {
  const g = load(), cal = new FakeCal(), state = {};
  g.CONFIG.RUN_BUDGET_SECONDS = -1;   // already over budget
  const r = g.reconcile_(cal, [mk('gs:a', 'PA4: Pixel Art', at('2026-11-06'))], {}, NOW, state, false);
  assert.equal(r.created, 0); assert.ok(r.deferred > 0);
});

test('default: no work blocks, countdown banners from start to due, old blocks removed', () => {
  const g = load(), cal = new FakeCal(), state = {};
  g.CONFIG.WORK_BLOCKS = true;
  const items = () => [mk('gs:a', 'PA4: Pixel Art', at('2026-11-06')), mk('gs:h', 'HW 7', at('2026-10-27', '17:00'), { course: 'MATH 229' }),
    mk('bs:r', 'Reading Response 9', at('2026-10-21', '18:00'), { course: 'GESM 120', source: 'brightspace' })];
  g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.ok(cal.live('block').length > 0);
  g.CONFIG.WORK_BLOCKS = false;                          // switch off: blocks go away
  g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.equal(cal.live('block').length, 0);
  const banners = cal.live('start');
  assert.equal(banners.length, 2, 'medium + big get banners, small does not');
  const pa = banners.find(b => /PA4/.test(b.summary));
  assert.equal(pa.summary, '📌 CSCI 103 · PA4: Pixel Art — due Fri 11/6 11:59PM');
  assert.deepEqual([pa.start.date, pa.end.date], ['2026-10-27', '2026-11-07']);
  const hw = banners.find(b => /HW 7/.test(b.summary));
  assert.deepEqual([hw.start.date, hw.end.date], ['2026-10-24', '2026-10-28']);
  assert.ok(!/Work plan/.test(cal.live('due')[0].description));
  const r = g.reconcile_(cal, items(), {}, NOW, state, false);
  assert.deepEqual([r.created, r.updated, r.deleted], [0, 0, 0]);
  // Submitted -> banner gone.
  g.reconcile_(cal, items().map(i => i.uid === 'gs:a' ? { ...i, submitted: true } : i), {}, NOW, state, false);
  assert.ok(!cal.live('start').some(b => /PA4/.test(b.summary)));
});

test('morning digest', () => {
  const g = load();
  const now = at('2026-10-20', '08:05').getTime();
  const u = (label, d, extra = {}) => ({ label, due: d.getTime(), tier: 'medium', url: '', source: 'gradescope', ...extra });
  const state = { lastSync: now - 600e3, upcoming: [
    u('MATH 229 · Hw 8', at('2026-10-23', '17:00')),
    u('CSCI 170 · Homework 6', at('2026-10-20', '23:59')),
    u('GESM 120 · Reading Response 9', at('2026-10-21', '18:00')),
    u('MATH 229 · Midterm 2', at('2026-11-04', '12:00'), { tier: 'big', source: 'syllabus', tentative: true })] };
  const d = g.buildDigest_(state, now);
  assert.equal(d.count, 3);
  assert.match(d.subject, /3 due this week · ⚠️ 2 in 48h — next: CSCI 170 · Homework 6, Today 11:59PM/);
  const lines = d.text.split('\n');
  assert.match(lines[0], /^• ⚠️ Today 11:59PM — CSCI 170 · Homework 6/);
  assert.match(lines[1], /^• ⚠️ Tomorrow 6PM — GESM 120/);
  assert.match(lines[2], /^• Fri 10\/23 5PM \(3 days\) — MATH 229 · Hw 8/);
  assert.match(d.text, /Coming up after that:\n• MATH 229 · Midterm 2 — Wed 11\/4/);
  assert.ok(!/Heads up/.test(d.text));
  assert.match(g.buildDigest_({ upcoming: [] }, now).subject, /Nothing due/);
  assert.match(g.buildDigest_({ lastSync: now - 9 * 3600e3, upcoming: [] }, now).text, /may be out of date/);
});

test('CS 103 course site: homework, projects (with late window), exams', () => {
  const g = load();
  const row = (...c) => '<tr>' + c.map(x => `<td>${x}</td>`).join('') + '</tr>';
  const html = `<html><body><h1>CSCI 103L - Fall 2026</h1><h2>Exams</h2><table><thead><tr><th>Exam</th><th>Time</th><th>Location</th><th>Info</th></tr></thead><tbody>
    ${row('Ex1', 'Thursday, September 24th', '(in class)', '<a href="#">Info</a>')}
    ${row('Ex3', 'Thursday, November 19th', '(in class)', 'Info')}
    ${row('Ex4', 'Thursday, December 3rd', '(in class)', 'Info')}
    ${row('Final', 'Saturday, December 12 11am - 1pm', 'TBA', 'Info')}
    </tbody></table><h2>Homework and Projects</h2><table><tr><th>Item</th><th>Title</th><th>Due (at 11:59PM Pacific)</th></tr>
    ${row('HW3', 'Classes', 'Friday, Oct. 30th')}
    ${row('HW4', 'Linked Lists &amp; Vectors', 'Friday, Nov. 6th')}
    ${row('PR3', 'Maze Search', 'Friday, Nov. 13th')}
    ${row('PR4', 'Streaming Service', 'Friday, Nov. 27th')}
    ${row('HW6', 'Recursion', 'Friday, December 4th')}
    ${row('PR9', 'Not yet released', 'TBA')}
    </table><h2>Labs</h2><table>${row('1', '8/28', 'Codio', 'Folder')}</table></body></html>`;
  const site = g.CONFIG.COURSE_SITES[0];
  const items = g.parseCourseSite_(html, site);
  const by = Object.fromEntries(items.map(i => [i.title, i]));
  assert.deepEqual(Object.keys(by).sort(), ['Exam 1', 'Exam 3', 'Exam 4', 'Final Exam', 'HW3: Classes', 'HW4: Linked Lists & Vectors', 'HW6: Recursion', 'PR3: Maze Search', 'PR4: Streaming Service']);
  assert.equal(by['HW3: Classes'].due.toISOString(), '2026-10-31T06:59:00.000Z');        // Fri 10/30 11:59pm PDT
  assert.equal(by['PR4: Streaming Service'].due.toISOString(), '2026-11-28T07:59:00.000Z');  // PST
  assert.equal(by['Exam 3'].due.toISOString(), '2026-11-19T17:30:00.000Z');                // 9:30am PST
  assert.equal(by['Final Exam'].due.toISOString(), '2026-12-12T19:00:00.000Z');            // 11am PST
  assert.equal(by['PR3: Maze Search'].extra.late_due, '2026-11-19T08:00:00.000Z');         // 12am morning of Exam 3
  assert.equal(by['HW3: Classes'].uid, 'by:cs103:HW3');
  assert.equal(by['HW3: Classes'].course, 'CSCI 103');
  // Sizing: homework medium, projects big, exams big/study, final 14-day study banner.
  assert.equal(g.classify_(by['HW3: Classes']).name, 'medium');
  assert.equal(g.classify_(by['PR3: Maze Search']).name, 'big');
  assert.equal(g.classify_(by['Exam 3']).label, 'Study');
  assert.equal(g.classify_(by['Final Exam']).startDays, 14);
  // Same exam also on Gradescope -> one item.
  const gsExam = mk('gs:9:1', 'Exam 3', at('2026-11-19', '09:30'));
  assert.equal(g.dedupe_([by['Exam 3'], gsExam]).length, 1);
});

test('course site parses real-world HTML with line breaks and nested tags', () => {
  const g = load();
  const html = `<table>
  <thead>
    <tr>
      <th>Item</th>
      <th>Title</th>
      <th>Due (at 11:59PM Pacific)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="hw3/">HW3</a></td>
      <td><strong>Classes</strong>
      </td>
      <td>Friday,
        Oct. 30th</td>
    </tr>
    <tr><td>Ex3</td>
        <td>Thursday, November 19th</td><td>(in class)</td><td><a href="x">Info</a></td></tr>
  </tbody>
</table>`;
  const items = g.parseCourseSite_(html, g.CONFIG.COURSE_SITES[0]);
  assert.deepEqual(items.map(i => i.title), ['HW3: Classes', 'Exam 3']);
  assert.equal(items[0].due.toISOString(), '2026-10-31T06:59:00.000Z');
});

test('course site ignores HTML comments / hidden columns (the real bytes page)', () => {
  const g = load();
  const html = `<!-- Regex Trap for ITS Disclaimer --><table><tr><th>Item</th><th>Title</th><th>Start</th><!-- <th>Release</th> --><th>Due (at 11:59PM Pacific)</th></tr>
  <tr><!-- hidden --><td>HW3</td><td>Classes</td><td></td><!-- <td>Oct 20</td> --><td>Friday, Oct. 30th</td></tr>
  <tr><td><!-- x -->PR3</td><td>Maze Search</td><td></td><td>--> Friday, Nov. 13th</td></tr></table>
  <table><tr><td>Ex3</td><td>Thursday, November 19th</td><td>(in class)</td></tr></table>`;
  const items = g.parseCourseSite_(html, g.CONFIG.COURSE_SITES[0]);
  assert.deepEqual(items.map(i => i.title), ['HW3: Classes', 'PR3: Maze Search', 'Exam 3']);
  assert.equal(items[1].extra.late_due, '2026-11-19T08:00:00.000Z');
});
