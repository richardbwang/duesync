/**
 * The trigger entry point. Runs every CONFIG.RUN_EVERY_MINUTES.
 * Each source is isolated: if one fails, its last good result is reused (for up
 * to 3 days) so a flaky run never looks like "all my assignments vanished".
 */

var RUN_STARTED_ = Date.now();
function overBudget_() { return Date.now() - RUN_STARTED_ > CONFIG.RUN_BUDGET_SECONDS * 1000; }

function run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('previous run still going; skipping'); return; }
  try {
    var r = runOnce_({ cal: googleCal_(), gmail: gmailSource_(), drive: driveSource_(), now: Date.now(), dryRun: false });
    console.log(r.summary);
  } finally {
    lock.releaseLock();
  }
}

/** Dependency-injected core so it can be tested outside Apps Script. */
function runOnce_(ctx) {
  RUN_STARTED_ = Date.now();
  var now = ctx.now, state = storeGet_('state', {}), failed = {}, notes = [], items = [];
  var last = state.lastRun || (state.lastRun = {});
  var force = ctx.force || {};

  // 1. Email: receipts + deadlines/events
  var emailEvents = [], toLabel = [];
  if (CONFIG.EMAIL.ENABLED && secret_('ANTHROPIC_API_KEY') && ctx.gmail) {
    try {
      var em = scanEmail_(ctx.gmail, state, now, ctx.extract);
      if (em.gsReceipt) force.gradescope = true;
      emailEvents = em.events;
      toLabel = em.toLabel;
      if (em.errors.length) { notes.push('email: ' + em.errors[0]); notify_(state, 'email', 'Email scanning error: ' + em.errors[0], now); }
    } catch (e) { notes.push('email FAILED: ' + e.message); notify_(state, 'email', 'Email scanning failed: ' + e.message, now); }
  }
  items = items.concat(unpackItems_(state.emailItems));

  // 1b. Syllabi in Drive (only new/changed files cost an API call)
  if (CONFIG.SYLLABUS.ENABLED && secret_('ANTHROPIC_API_KEY') && ctx.drive &&
      (force.syllabus || now - (last.syllabus || 0) >= CONFIG.SYLLABUS.EVERY_MINUTES * MIN - 30 * 1000)) {
    try {
      var sy = scanSyllabi_(ctx.drive, state, now, ctx.extractSyllabus);
      last.syllabus = now;
      if (sy.processed) notes.push('syllabi read: ' + sy.processed);
      if (sy.errors.length) notify_(state, 'syllabus', 'Could not read a syllabus: ' + sy.errors[0], now);
    } catch (e) { notes.push('syllabus FAILED: ' + e.message); }
  }
  items = items.concat(unpackItems_(state.syllabusItems));

  // 2. Brightspace + Gradescope, each on its own cadence, with cached fallback
  var sources = [
    { name: 'brightspace', every: CONFIG.BRIGHTSPACE_EVERY_MINUTES, fetch: ctx.fetchBrightspace || fetchBrightspace_ },
    { name: 'gradescope', every: CONFIG.GRADESCOPE_EVERY_MINUTES, fetch: ctx.fetchGradescope || fetchGradescope_ },
    { name: 'coursesite', every: CONFIG.COURSE_SITE_EVERY_MINUTES, fetch: ctx.fetchCourseSites || fetchCourseSites_ }
  ];
  sources.forEach(function (s) {
    var cacheKey = 'cache_' + s.name;
    var due = force[s.name] || now - (last[s.name] || 0) >= s.every * MIN - 30 * 1000;
    if (due) {
      try {
        var got = s.fetch();
        if (got === null) return;                         // not configured: skip silently
        storeSet_(cacheKey, { at: now, items: packItems_(got) });
        last[s.name] = now;
        notes.push(s.name + ': ' + got.length);
        items = items.concat(got);
        return;
      } catch (e) {
        notes.push(s.name + ' FAILED: ' + e.message);
        var auth = e.name === 'GsAuthError';
        notify_(state, s.name, s.name + (auth ? ' login failed: ' : ' failed: ') + e.message +
          (auth ? '\n\nCheck GS_EMAIL / GS_PASSWORD in Script Properties.' : ''), now);
      }
    }
    var cache = storeGet_(cacheKey, null);
    if (cache && now - cache.at < 3 * DAY) items = items.concat(unpackItems_(cache.items));
    else failed[s.name] = true;                           // no data: leave its calendar events untouched
  });

  // Save scan progress first: a calendar error must not force re-reading syllabi/emails.
  if (!ctx.dryRun) storeSet_('state', state);
  if (!ctx.dryRun) toLabel.forEach(function (t) { try { ctx.gmail.markDone(t.thread, t.added); } catch (e) { console.log('label: ' + e); } });

  // 3. Calendar
  var rep, placed = 0;
  try {
    rep = reconcile_(ctx.cal, items, failed, now, state, ctx.dryRun);
    placed = emailEvents.length ? placeEvents_(ctx.cal, emailEvents, state, now, ctx.dryRun) : 0;
  } finally {
    if (!ctx.dryRun) storeSet_('state', state);   // keep partial progress (block ids) even if a write fails
  }

  // Snapshot for the morning digest.
  if (!ctx.dryRun && rep) {
    state.upcoming = rep.plans.filter(function (p) { return !p.item.submitted && p.item.due.getTime() > now; }).map(function (p) {
      return { label: itemLabel_(p.item), due: p.item.due.getTime(), tier: p.tier.name, url: p.item.url || '',
               source: p.item.source, tentative: p.item.source === 'syllabus' };
    }).slice(0, 80);
    state.lastSync = now;
    storeSet_('state', state);
  }
  var summary = (ctx.dryRun ? '[dry run] ' : '') + notes.join(' · ') + ' → created ' + rep.created + ', updated ' + rep.updated +
    ', deleted ' + rep.deleted + (placed ? ', email events ' + placed : '') +
    (rep.deferred ? ' (' + rep.deferred + ' more next run)' : '');
  return { summary: summary, report: rep, state: state };
}

/** Email yourself about a problem, at most every NOTIFY_EVERY_HOURS per source. */
function notify_(state, key, msg, now) {
  var n = state.notified || (state.notified = {});
  if (now - (n[key] || 0) < CONFIG.NOTIFY_EVERY_HOURS * HOUR) return;
  n[key] = now;
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'DueSync: ' + key + ' needs attention', msg +
      '\n\n(Open script.google.com > DueSync > Executions for details. You\'ll get at most one of these every ' +
      CONFIG.NOTIFY_EVERY_HOURS + 'h.)');
  } catch (e) { console.log('notify failed: ' + e); }
}
