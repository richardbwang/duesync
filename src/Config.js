/**
 * DueSync settings. Secrets do NOT go here — they live in
 * Project Settings > Script Properties:
 *   ANTHROPIC_API_KEY     Claude API key (email scanning)
 *   BRIGHTSPACE_ICS_URL   Brightspace > Calendar > Subscribe link
 *   GS_EMAIL, GS_PASSWORD Gradescope's own login (set via "Forgot password" on gradescope.com)
 */
var CONFIG = {
  TIMEZONE: 'America/Los_Angeles',          // keep in sync with appsscript.json
  CALENDAR_NAME: 'Coursework',              // deadlines, start markers, work blocks, required events
  MAYBE_CALENDAR_NAME: 'USC Events (maybe)', // optional events from email; toggle it on/off in GCal
  HORIZON_DAYS: 120,

  RUN_EVERY_MINUTES: 10,                    // Apps Script allows 1, 5, 10, 15 or 30
  BRIGHTSPACE_EVERY_MINUTES: 30,
  GRADESCOPE_EVERY_MINUTES: 60,             // plus immediately when a submission receipt arrives
  NOTIFY_EVERY_HOURS: 12,
  MAX_CALENDAR_WRITES_PER_RUN: 60,
  RUN_BUDGET_SECONDS: 270,                  // Apps Script kills runs at 6 min; stop writing well before that           // first sync spreads over a few runs instead of hitting Google's rate limit                   // max frequency of "something broke" emails to you

  EMAIL: {
    ENABLED: true,
    MODEL: 'claude-haiku-5-5',
    // Which mail to consider. Handled threads get the duesync/checked label (search syntax: label:duesync-checked).
    QUERY: 'newer_than:3d (from:usc.edu OR from:gradescope.com OR from:codio.com OR to:usc.edu) ' +
           '-from:me -category:promotions -label:duesync-checked',
    MAX_THREADS_PER_RUN: 20,
    MAX_LLM_CALLS_PER_RUN: 12,
    BODY_CHARS: 6000,
    // Cheap check before spending an API call: only mail that smells like a date/deadline/event.
    PREFILTER: /\b(due|deadline|exam|midterm|final|quiz|submit|rsvp|register|meeting|event|workshop|fair|talk|seminar|interview|appointment|tomorrow|tonight|today|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\d{1,2}(:\d{2})?\s?(am|pm)|\d{1,2}\/\d{1,2}/i
  },

  // Public course websites, re-read every COURSE_SITE_EVERY_MINUTES.
  COURSE_SITES: [
    { KEY: 'cs103', COURSE: 'CSCI 103', URL: 'https://bytes.usc.edu/cs103/assignments/',
      YEAR: 2026, DUE_TIME: '23:59', EXAM_TIME: '09:30' }   // in-class exams: T/Th 9:30am lecture
  ],
  COURSE_SITE_EVERY_MINUTES: 360,

  SYLLABUS: {
    ENABLED: true,
    FOLDER_NAME: 'duesync syllabi',         // a folder in your Google Drive; drop syllabus PDFs / Google Docs here
    TERM: 'Fall 2026 (late August to mid December 2026)',
    EVERY_MINUTES: 30
  },

  // Told to Claude when reading email, so it can decide what you're committed to.
  ABOUT_ME:
    'USC computer science freshman (Fall 2026). Courses: CSCI 103 (intro C++ programming), ' +
    'CSCI 170 (discrete math), MATH 229 (multivariable calculus), GESM 120 (Jewish-Muslim relations). ' +
    'Involved in LavaLab (startup incubator). Interested in startups, AI/ML, robotics.',
  // How Claude should sort events found in email.
  EMAIL_POLICY:
    'required: exams, quizzes, class schedule changes, assignment deadlines, appointments or interviews I booked, ' +
    'events I RSVPed or registered for, meetings I was explicitly invited to.\n' +
    'optional: club meetings, info sessions, career fairs, workshops, guest talks, socials, hackathons, ' +
    'research/lab talks, startup or entrepreneurship events (lean toward including these, I like them).\n' +
    'ignore: marketing, fundraising, surveys, newsletters with no specific event, anything already past.',

  // Short course labels (regex on the platform's course text -> label).
  COURSE_ALIASES: {},

  // Work blocks: time reserved in your free calendar slots for medium/big items. Off = deadlines,
  // reminders and a daily countdown banner only. Existing blocks are removed when this is off.
  WORK_BLOCKS: false,

  // Morning email listing everything due soon.
  DIGEST: { ENABLED: true, HOUR: 8, DAYS_AHEAD: 7 },

  // How much heads-up each size gets. reminders = popups before the deadline (Google: max 5, max 4 weeks).
  // start_days_before = when the daily 📌 countdown banner begins. work_hours only matters if WORK_BLOCKS is on.
  TIERS: {
    small:  { reminders: ['1d', '3h'] },
    medium: { reminders: ['3d', '1d', '3h'], start_days_before: 3, work_hours: 3 },
    big:    { reminders: ['14d', '7d', '3d', '1d', '3h'], start_days_before: 10, work_hours: 12 }
  },
  // First match wins. match = regex on "COURSE title"; course = regex on course; min_points = Gradescope points.
  RULES: [
    { match: /\bfinal\b.*(exam|test)|\bfinal exam/i, tier: 'big', label: 'Study', work_hours: 15, start_days_before: 14 },
    { match: /midterm|\bexam\b/i, tier: 'big', label: 'Study', work_hours: 8, start_days_before: 7 },
    { match: /proposal|outline|abstract|annotated bibliography/i, tier: 'medium', work_hours: 3 },
    { match: /presentation/i, tier: 'medium', work_hours: 4 },
    { match: /project|design product|prototype|\bP[AR] ?\d|programming assignment|final paper|essay/i, tier: 'big' },
    { match: /homework|\bhw ?\d|problem set|\bpset|written assignment/i, tier: 'medium' },
    { match: /quiz|reading|response|discussion|participation|survey|check-?in|lecture|attendance/i, tier: 'small' },
    { min_points: 50, tier: 'big' }
  ],
  DEFAULT_TIER: 'small',

  SCHEDULE: {
    BUSY_CALENDARS: ['primary'],     // calendars whose events block work time (add your class schedule's id)
    WEEKDAY_WINDOW: ['10:00', '23:00'],
    WEEKEND_WINDOW: ['11:00', '23:00'],
    BLOCK_MINUTES: 90,
    MIN_BLOCK_MINUTES: 45,
    BUFFER_MINUTES: 10,
    MAX_HOURS_PER_DAY_PER_ITEM: 3,
    MAX_HOURS_PER_DAY_TOTAL: 5,
    FINISH_HOURS_BEFORE_DUE: 12
  },

  // Google Calendar color ids: 11 tomato, 6 tangerine, 5 banana, 2 sage, 8 graphite, 9 blueberry, 7 peacock
  COLORS: { big: '11', medium: '6', small: '8', done: '2', event: '9', maybe: '7' }
};
