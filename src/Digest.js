/**
 * Morning email: everything due in the next CONFIG.DIGEST.DAYS_AHEAD days,
 * soonest first, with ⚠️ on anything due within 48 hours. Built from the
 * snapshot the 10-minute sync saves, so it costs no extra fetching.
 */

function digest() {
  if (!CONFIG.DIGEST.ENABLED) return;
  var d = buildDigest_(storeGet_('state', {}), Date.now());
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: d.subject, body: d.text, htmlBody: d.html, name: 'DueSync' });
}

function buildDigest_(state, now) {
  var horizon = now + CONFIG.DIGEST.DAYS_AHEAD * DAY;
  var items = (state.upcoming || []).filter(function (u) { return u.due > now && u.due <= horizon; })
    .sort(function (a, b) { return a.due - b.due; });
  var todayKey = dayKey_(new Date(now)), tomorrowKey = addDaysKey_(todayKey, 1);

  function when(u) {
    var k = dayKey_(new Date(u.due)), t = fmt_(new Date(u.due), 'h:mma').replace(':00', '');
    if (k === todayKey) return 'Today ' + t;
    if (k === tomorrowKey) return 'Tomorrow ' + t;
    var days = Math.round((dayStart_(k) - dayStart_(todayKey)) / DAY);
    return fmt_(new Date(u.due), 'EEE M/d') + ' ' + t + ' (' + days + ' days)';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  var urgent = items.filter(function (u) { return u.due - now <= 48 * HOUR; }).length;
  var subject = items.length
    ? '📚 ' + items.length + ' due this week' + (urgent ? ' · ⚠️ ' + urgent + ' in 48h' : '') + ' — next: ' + items[0].label + ', ' + when(items[0])
    : '📚 Nothing due in the next ' + CONFIG.DIGEST.DAYS_AHEAD + ' days';

  var text = [], rows = [];
  items.forEach(function (u) {
    var flag = u.due - now <= 48 * HOUR ? '⚠️ ' : '';
    var line = flag + when(u) + ' — ' + u.label + (u.tentative ? ' (tentative, from syllabus)' : '') + (u.tier === 'big' ? ' [big]' : '');
    text.push('• ' + line + (u.url ? '\n  ' + u.url : ''));
    rows.push('<tr><td style="padding:4px 12px 4px 0;white-space:nowrap;' + (flag ? 'color:#c5221f;font-weight:600' : 'color:#5f6368') + '">' +
      esc(flag + when(u)) + '</td><td style="padding:4px 0">' + (u.url ? '<a href="' + esc(u.url) + '">' + esc(u.label) + '</a>' : esc(u.label)) +
      (u.tentative ? ' <span style="color:#80868b">(tentative)</span>' : '') + (u.tier === 'big' ? ' <b>· big</b>' : '') + '</td></tr>');
  });
  var later = (state.upcoming || []).filter(function (u) { return u.due > horizon && u.tier === 'big'; })
    .sort(function (a, b) { return a.due - b.due; }).slice(0, 3);
  var laterText = later.map(function (u) { return u.label + ' — ' + fmt_(new Date(u.due), 'EEE M/d'); });

  var stale = !state.lastSync || now - state.lastSync > 6 * HOUR;
  var staleNote = stale ? 'Heads up: the last successful sync was ' + (state.lastSync ? prettyDate_(new Date(state.lastSync)) : 'never') +
    ', so this list may be out of date. Check script.google.com > DueSync > Executions.' : '';

  var body = (items.length ? text.join('\n') : 'Nothing due in the next ' + CONFIG.DIGEST.DAYS_AHEAD + ' days.') +
    (laterText.length ? '\n\nComing up after that:\n• ' + laterText.join('\n• ') : '') + (staleNote ? '\n\n' + staleNote : '');
  var html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#202124">' +
    (items.length ? '<table style="border-collapse:collapse">' + rows.join('') + '</table>' : '<p>Nothing due in the next ' + CONFIG.DIGEST.DAYS_AHEAD + ' days.</p>') +
    (laterText.length ? '<p style="margin-top:16px;color:#5f6368">Coming up after that: ' + esc(laterText.join(' · ')) + '</p>' : '') +
    (staleNote ? '<p style="color:#c5221f">' + esc(staleNote) + '</p>' : '') + '</div>';
  return { subject: subject, text: body, html: html, count: items.length };
}

/** Send today's digest right now (for testing). */
function testDigest() { digest(); console.log('Digest sent to ' + Session.getEffectiveUser().getEmail()); }
