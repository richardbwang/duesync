/**
 * Run these from the Apps Script editor (pick the function in the toolbar, click Run).
 *   setup()        create calendars, install the trigger, first sync
 *   preview()      log what a sync would do, without changing anything
 *   status()       check every piece is configured and working
 *   testBrightspace(), testGradescope(), testEmail(), testSyllabi()  inspect one source
 *   testDigest()   send the morning email now
 *   uninstall()    stop the trigger (calendar events stay)
 */

function setup() {
  status();
  var cal = googleCal_(), state = storeGet_('state', {});
  state.calendarId = cal.ensure(CONFIG.CALENDAR_NAME, state.calendarId);
  storeSet_('state', state);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run' || t.getHandlerFunction() === 'digest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(CONFIG.RUN_EVERY_MINUTES).create();
  if (CONFIG.DIGEST.ENABLED) {
    ScriptApp.newTrigger('digest').timeBased().atHour(CONFIG.DIGEST.HOUR).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
    console.log('Morning digest: daily between ' + CONFIG.DIGEST.HOUR + ':00 and ' + (CONFIG.DIGEST.HOUR + 1) + ':00.');
  }
  console.log('Trigger installed: run() every ' + CONFIG.RUN_EVERY_MINUTES + ' min. Running the first sync now…');
  run();
}

function preview() {
  var r = runOnce_({ cal: googleCal_(), gmail: null, drive: null, now: Date.now(), dryRun: true, force: { brightspace: true, gradescope: true } });
  r.report.plans.slice().sort(function (a, b) { return a.item.due - b.item.due; }).forEach(function (p) {
    if (p.item.due.getTime() < Date.now()) return;
    var extra = '';
    if (p.tier.workMin && !p.item.submitted) {
      extra = '  plan ' + (p.planned / 60).toFixed(1) + '/' + (p.tier.workMin / 60) + 'h' + (p.create.length ? ' (+' + p.create.length + ' blocks)' : '') +
        (p.shortfallMin ? '  ⚠ short' : '');
    }
    console.log((p.item.submitted ? '✅ ' : '   ') + fmt_(p.item.due, 'EEE MM/dd h:mma') + '  [' + p.tier.name + '] ' +
      itemLabel_(p.item) + '  (' + p.item.source + ')' + extra);
  });
  console.log(r.summary);
}

function status() {
  var ok = function (b, what, detail) { console.log((b ? 'OK   ' : 'MISSING ') + what + (detail ? ' — ' + detail : '')); };
  ok(!!secret_('BRIGHTSPACE_ICS_URL'), 'BRIGHTSPACE_ICS_URL', 'Brightspace > Calendar > Subscribe');
  ok(!!(secret_('GS_EMAIL') && secret_('GS_PASSWORD')), 'GS_EMAIL + GS_PASSWORD', 'Gradescope\'s own login');
  ok(!!secret_('ANTHROPIC_API_KEY') || !CONFIG.EMAIL.ENABLED, 'ANTHROPIC_API_KEY', CONFIG.EMAIL.ENABLED ? 'email scanning' : 'email scanning off');
  if (CONFIG.SYLLABUS.ENABLED) {
    var f = driveSource_().files();
    ok(f !== null, 'Drive folder "' + CONFIG.SYLLABUS.FOLDER_NAME + '"', f === null ? 'create it in Google Drive and drop syllabus PDFs in' : f.length + ' file(s)');
  }
  var trig = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'run'; }).length;
  ok(trig > 0, 'trigger', trig ? 'every ' + CONFIG.RUN_EVERY_MINUTES + ' min' : 'run setup()');
  var st = storeGet_('state', {});
  console.log('Last runs: ' + JSON.stringify(Object.keys(st.lastRun || {}).reduce(function (o, k) {
    o[k] = fmt_(new Date(st.lastRun[k]), 'MM/dd HH:mm'); return o; }, {})));
}

function testBrightspace() {
  var items = fetchBrightspace_();
  if (items === null) return console.log('BRIGHTSPACE_ICS_URL not set');
  items.sort(function (a, b) { return a.due - b.due; }).forEach(function (i) {
    console.log(fmt_(i.due, 'EEE MM/dd h:mma') + '  [' + classify_(i).name + '] ' + itemLabel_(i));
  });
  console.log(items.length + ' items');
}

function testGradescope() {
  var items = fetchGradescope_();
  if (items === null) return console.log('GS_EMAIL not set');
  items.sort(function (a, b) { return a.due - b.due; }).forEach(function (i) {
    console.log((i.submitted ? '✅ ' : '   ') + fmt_(i.due, 'EEE MM/dd h:mma') + '  [' + classify_(i).name + '] ' + itemLabel_(i));
  });
  console.log(items.length + ' items');
}

/** Extracts from your 5 newest matching emails and logs the result. Writes nothing. */
function testEmail() {
  GmailApp.search(CONFIG.EMAIL.QUERY.replace('-label:duesync-checked', ''), 0, 5).forEach(function (t) {
    var m = t.getMessages().pop();
    var msg = { from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toString(), body: m.getPlainBody() || '' };
    var pass = CONFIG.EMAIL.PREFILTER.test(msg.subject + ' ' + msg.body.slice(0, 3000));
    console.log('— ' + msg.subject + (pass ? '' : '  (skipped by prefilter)'));
    if (pass) console.log(JSON.stringify(claudeExtract_(msg, Date.now()), null, 1));
  });
}

/** Reads every file in the syllabus folder and logs what it finds. Writes nothing. */
function testSyllabi() {
  var files = driveSource_().files();
  if (files === null) return console.log('No Drive folder named "' + CONFIG.SYLLABUS.FOLDER_NAME + '" yet');
  files.forEach(function (f) {
    var res = syllabusExtract_({ name: f.name, pdfBytes: f.load() }, Date.now());
    console.log('— ' + f.name + ' → ' + (res.course || '?'));
    (res.items || []).forEach(function (x) { console.log('   ' + x.kind + '  ' + x.start + '  ' + x.title + (x.note ? '  (' + x.note + ')' : '')); });
  });
}

/** Forget which syllabi were read, so the next run re-reads them all. */
function rereadSyllabi() {
  var st = storeGet_('state', {});
  st.syllabi = {}; st.syllabusItems = [];
  storeSet_('state', st);
  console.log('Syllabi will be re-read on the next run.');
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  console.log('Trigger removed. Calendar events were left in place; delete the Coursework calendar to remove them.');
}
