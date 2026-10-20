/**
 * Syllabi: drop PDFs (or Google Docs) into the Drive folder CONFIG.SYLLABUS.FOLDER_NAME.
 * Each new or changed file is read once by Claude, which pulls out exams and
 * major deliverables. Those join the planner like any assignment, labeled as
 * tentative; if Brightspace, Gradescope or an email later lists the same thing
 * within a week of that date, the newer source wins (see dedupe_).
 */

var SYLLABUS_TOOL = {
  name: 'record_dates',
  description: 'Record exams and major graded deliverables that have a specific calendar date.',
  input_schema: {
    type: 'object',
    properties: {
      course: { type: 'string', description: 'Course code, e.g. "CSCI 170"' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['exam', 'deadline'] },
            title: { type: 'string', description: 'e.g. "Midterm 1", "Final Exam", "Final Project", "Research Paper"' },
            start: { type: 'string', description: 'ISO 8601 with UTC offset. Exams: start time (use 09:00 if no time given). Deadlines: due time (23:59 if none).' },
            note: { type: 'string', description: 'Short note, e.g. "in class", "tentative", "covers ch. 1-5"' }
          },
          required: ['kind', 'title', 'start']
        }
      }
    },
    required: ['course', 'items']
  }
};

function syllabusExtract_(file, now) {
  var key = secret_('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');
  var system = 'You read a course syllabus for a USC student. Today is ' + fmt_(new Date(now), 'yyyy-MM-dd') +
    ' (' + CONFIG.TIMEZONE + '); the term is ' + CONFIG.SYLLABUS.TERM + '. Extract ONLY exams (midterms, finals, ' +
    'major quizzes/tests) and major graded deliverables (projects, papers, presentations, final portfolios). ' +
    'Skip weekly homework, readings and labs. Only include items with a specific calendar date; if the syllabus ' +
    'gives only a week number, convert it to a date only when the syllabus states the class meeting days and the ' +
    'term start, otherwise skip it. Skip anything before today.';
  var payload = {
    model: CONFIG.EMAIL.MODEL, max_tokens: 2000, system: system,
    tools: [SYLLABUS_TOOL], tool_choice: { type: 'tool', name: 'record_dates' },
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(file.pdfBytes) } },
      { type: 'text', text: 'File name: ' + file.name }
    ] }]
  };
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    });
    var code = res.getResponseCode();
    if (code === 200) {
      var use = (JSON.parse(res.getContentText()).content || []).filter(function (c) { return c.type === 'tool_use'; })[0];
      return use ? use.input : { course: '', items: [] };
    }
    if (code !== 429 && code < 500) throw new Error('Claude API ' + code + ': ' + res.getContentText().slice(0, 300));
    Utilities.sleep(2000 * (attempt + 1));
  }
  throw new Error('Claude API unavailable (retried)');
}

/** Drive adapter (faked in tests). Returns null if the folder doesn't exist yet. */
function driveSource_() {
  return {
    files: function () {
      var it = DriveApp.getFoldersByName(CONFIG.SYLLABUS.FOLDER_NAME);
      if (!it.hasNext()) return null;
      var out = [], files = it.next().getFiles();
      while (files.hasNext()) {
        var f = files.next(), mime = f.getMimeType();
        if (mime !== MimeType.PDF && mime !== MimeType.GOOGLE_DOCS) continue;
        out.push({
          id: f.getId(), name: f.getName(), updated: f.getLastUpdated().getTime(),
          load: (function (file, m) {
            return function () { return (m === MimeType.PDF ? file.getBlob() : file.getAs(MimeType.PDF)).getBytes(); };
          })(f, mime)
        });
      }
      return out;
    }
  };
}

/** Updates state.syllabusItems / state.syllabi. Returns {processed, errors, missingFolder}. */
function scanSyllabi_(drive, state, now, extract) {
  extract = extract || syllabusExtract_;
  var files = drive.files(), out = { processed: 0, errors: [], missingFolder: files === null };
  if (files === null) return out;
  var seen = state.syllabi || {}, items = unpackItems_(state.syllabusItems), present = {};
  files.forEach(function (f) {
    present[f.id] = 1;
    if (seen[f.id] && seen[f.id].updated === f.updated) return;
    var res;
    try { res = extract({ name: f.name, pdfBytes: f.load() }, now); }
    catch (e) { out.errors.push(f.name + ': ' + (e.message || e)); return; }
    var course = courseLabel_(res.course, f.name) || res.course || '';
    items = items.filter(function (i) { return i.extra.file !== f.id; });     // replace this file's items
    (res.items || []).forEach(function (x) {
      var start = new Date(x.start);
      if (isNaN(start) || start.getTime() < now) return;
      items.push({ uid: 'sy:' + stableId_(f.id, x.title.toLowerCase()), source: 'syllabus', course: course, title: x.title,
                   due: start, url: 'https://drive.google.com/file/d/' + f.id, submitted: false,
                   extra: { file: f.id, fileName: f.name, note: x.note || '' } });
    });
    seen[f.id] = { updated: f.updated, name: f.name, at: now };
    out.processed++;
  });
  Object.keys(seen).forEach(function (id) { if (!present[id]) delete seen[id]; });          // file removed
  items = items.filter(function (i) { return present[i.extra.file] && i.due.getTime() > now - 7 * DAY; });
  state.syllabi = seen;
  state.syllabusItems = packItems_(items);
  return out;
}
