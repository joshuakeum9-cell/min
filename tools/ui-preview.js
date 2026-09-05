/**
 * Serves app/index.html so the interface can be inspected in a browser during
 * design work. Development only, the real app loads the same file through
 * Electron, where window.api exists.
 *
 * The renderer expects window.api (an Electron preload bridge). Here that is
 * absent, so a small stub is served at /__api-stub.js: enough for the layout
 * and every view to render with plausible content, and nothing that touches
 * disk. The stub mirrors preload.cjs call for call; when the bridge grows, this
 * file grows with it, or the preview stops being a faithful picture.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const DOCS = path.join(ROOT, 'docs');
const PORT = 4173;
const HOST = '127.0.0.1'; // loopback only: this serves files off the developer's disk.

// Windows compares paths case-insensitively, so the containment test must too.
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// The real bridge reports app.getVersion(); the preview reads the same source.
const VERSION = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
  .then((t) => JSON.parse(t).version)
  .catch(() => '0.0.0');

/**
 * The path part of a request URL, percent-decoded. Null when the escape
 * sequences are malformed or the path carries a NUL byte, both of which only
 * ever show up in an attempt to confuse the path handling below.
 */
function pathnameOf(url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  return decoded.includes('\0') ? null : decoded;
}

/**
 * Resolve `relative` under `base`, or null if it escapes. req.url is whatever
 * the client sent, so a request for docs/../../../.ssh/id_rsa must resolve to
 * nothing rather than to a file. Compares against base plus a trailing
 * separator so a sibling like docs-private cannot pass as a child of docs.
 */
function resolveInside(base, relative) {
  const full = path.resolve(base, relative);
  const guard = base.endsWith(path.sep) ? base : base + path.sep;
  if (fold(full) !== fold(base) && !fold(full).startsWith(fold(guard))) return null;
  return full;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/*
 * Everything below runs in the browser. Dates are built relative to the moment
 * the page loads, so "Today" is always today and the in-progress event is
 * always in progress, whenever the screenshot is taken.
 */
const STUB_JS = `
  const APP_VERSION = ${JSON.stringify(VERSION)};
  const MEETINGS_DIR = 'C:\\\\Users\\\\You\\\\Meetings';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // Local wall clock at h:m on a day offset from today. ISO strings cross the
  // real bridge, so the stub hands out the same.
  const at = (dayOffset, h, m = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m, 0, 0);
    return d.toISOString();
  };
  const dayKey = (dayOffset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  const dayLabel = (dayOffset) => {
    if (dayOffset === 0) return 'Today';
    if (dayOffset === 1) return 'Tomorrow';
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  };

  /* ------------------------------------------------------------ meetings */

  const FAKE = [
    { id: 'vendor-sync', dir: '/m/1', title: 'Vendor sync', startedAt: at(0, 9, 0),
      durationSeconds: 2760, transcribed: true, written: true, hasAudio: false,
      attendees: ['Priya Nair', 'Tom Ellis'],
      calendarEvent: { uid: 'ev-vendor', title: 'Vendor sync', start: at(0, 9, 0), end: at(0, 9, 45),
        attendees: ['Priya Nair', 'Tom Ellis'], recurring: true } },
    { id: 'hiring-loop', dir: '/m/2', title: 'Hiring loop review', startedAt: at(-1, 10, 30),
      durationSeconds: 1920, transcribed: true, written: false, hasAudio: true,
      attendees: ['Dana Whitfield', 'Marcus Chen', 'Ines Okafor'],
      calendarEvent: { uid: 'ev-hiring', title: 'Hiring loop review', start: at(-1, 10, 30), end: at(-1, 11, 0),
        attendees: ['Dana Whitfield', 'Marcus Chen', 'Ines Okafor'], recurring: false } },
    { id: 'infra-costs', dir: '/m/3', title: 'Infra costs', startedAt: at(-1, 16, 15),
      durationSeconds: 1500, transcribed: false, written: false, hasAudio: true },
    { id: 'design-crit', dir: '/m/4', title: 'Design crit', startedAt: at(-2, 14, 0),
      durationSeconds: 3300, transcribed: true, written: true, hasAudio: false },
  ];
  const BODY = {
    '/m/1': {
      notes: '# Timeline\\n- pilot slipping?\\n- schema freeze friday\\n\\n# Risks\\n- vendor again\\n- legal DPA lead time\\n\\n# Mine\\n- open the ticket',
      transcript: '[00:00:00] Them: We should push the pilot to the second week of October.\\n[00:00:17] You: That works, but it compresses the review window to four days.\\n[00:00:34] Them: Four days is enough if we get the schema frozen by Friday.\\n[00:00:41] Them: And the vendor has to actually ship this time.\\n[00:00:58] You: I will open the legal ticket this afternoon so the DPA is not the long pole.',
      note: '# Timeline\\n\\nThe pilot is moving to the second week of October, the data team is not ready. That compresses the review window to four days, which works only if the schema is frozen by Friday.\\n\\n# Risks\\n\\nThe vendor may slip again. The fallback is one more manual export cycle, which nobody wants to run in December.\\n\\n# Mine\\n\\nOpen the legal ticket this afternoon. The DPA takes ten working days.',
    },
    '/m/2': {
      notes: '# Loop\\n- 4 rounds too many?\\n- take-home vs pairing\\n\\n# Decide\\n- drop the system design round for juniors',
      transcript: '[00:00:00] Them: Four rounds is scaring off the good candidates.\\n[00:00:12] You: Agreed. Which one goes?\\n[00:00:20] Them: System design, for the junior loop at least.',
      note: null,
    },
  };

  /* ------------------------------------------------------------ calendar */

  let settings = {
    calendarUrl: 'https://calendar.google.com/calendar/ical/preview%40example.com/private-0000/basic.ics',
    calendarRefreshMinutes: 15,
    liveTranscript: true,
    provider: 'claude',
    alwaysOnTop: true,
  };
  const SETTING_KEYS = Object.keys(settings);

  // Starts an hour ago and ends in half an hour, so it is always in progress.
  const nowHour = now.getHours();
  const inProgressStart = new Date(now.getTime() - 60 * 60000);
  const inProgressEnd = new Date(now.getTime() + 30 * 60000);
  const ev = (o) => ({ allDay: false, location: '', attendees: [], recurring: false, ...o,
    attendeeCount: (o.attendees ?? []).length });

  const AGENDA = [
    { day: dayKey(0), label: dayLabel(0), isToday: true, events: [
      ev({ id: 'e1', uid: 'ev-standup', title: 'Platform standup', start: at(0, 9, 30), end: at(0, 9, 45),
        attendees: ['Priya Nair', 'Tom Ellis', 'Marcus Chen'], recurring: true }),
      ev({ id: 'e2', uid: 'ev-pricing', title: 'Pricing review with finance',
        start: inProgressStart.toISOString(), end: inProgressEnd.toISOString(),
        attendees: ['Dana Whitfield', 'Ines Okafor'], location: 'Room 4B', inProgress: true }),
      ev({ id: 'e3', uid: 'ev-class', title: 'CS 6.824 Distributed Systems',
        start: at(0, Math.min(nowHour + 2, 21), 5), end: at(0, Math.min(nowHour + 3, 22), 5),
        location: 'Stata 32-123', recurring: true }),
    ] },
    { day: dayKey(1), label: dayLabel(1), isToday: false, events: [
      ev({ id: 'e4', uid: 'ev-standup', title: 'Platform standup', start: at(1, 9, 30), end: at(1, 9, 45),
        attendees: ['Priya Nair', 'Tom Ellis', 'Marcus Chen'], recurring: true }),
      ev({ id: 'e5', uid: 'ev-1on1', title: '1:1 with Dana', start: at(1, 11, 0), end: at(1, 11, 30),
        attendees: ['Dana Whitfield'], recurring: true }),
      ev({ id: 'e6', uid: 'ev-offsite', title: 'Q4 planning offsite', start: at(1, 13, 0), end: at(1, 17, 0),
        attendees: ['Priya Nair', 'Tom Ellis', 'Dana Whitfield', 'Marcus Chen', 'Ines Okafor', 'Sam Rivera'],
        location: 'The Foundry' }),
    ] },
  ];
  const EVENT_NOW = (() => {
    const e = AGENDA[0].events[1];
    return { uid: e.uid, title: e.title, start: e.start, end: e.end, attendees: e.attendees, recurring: e.recurring };
  })();

  /* ---------------------------------------------------------------- live */

  const LIVE_SEGMENTS = [
    { track: 'them', t0: 0.0,  t1: 4.2,  text: 'Right, so the headline is that finance wants the tier change in before Q4 closes.' },
    { track: 'you',  t0: 4.9,  t1: 8.1,  text: 'Before the offsite, or before the quarter actually ends?' },
    { track: 'them', t0: 8.6,  t1: 12.3, text: 'Before the offsite, ideally. They want to present it there.' },
    { track: 'them', t0: 12.5, t1: 15.0, text: 'Which gives us about two weeks.' },
    { track: 'you',  t0: 15.8, t1: 20.4, text: 'Then the migration script has to be done by Friday. I can take that.' },
  ];
  const listeners = { segment: new Set(), status: new Set(), calendar: new Set() };
  const subscribe = (set) => (cb) => { set.add(cb); return () => set.delete(cb); };
  const emit = (set, payload) => { for (const cb of set) { try { cb(payload); } catch {} } };
  let liveTimers = [];
  const clearLive = () => { for (const t of liveTimers) clearTimeout(t); liveTimers = []; };

  window.api = {
    /* unchanged from the shipped bridge */
    meetingsDir: async () => MEETINGS_DIR,
    setAlwaysOnTop: async () => true,
    listMeetings: async () => FAKE,
    readMeeting: async (dir) => {
      const m = FAKE.find((x) => x.dir === dir) ?? FAKE[0];
      const b = BODY[dir] ?? { notes: '(no notes typed)', transcript: null, note: null };
      return { ...m, ...b };
    },
    // Title match with a marked snippet, in the shape library.search returns.
    search: async (q) => {
      const needle = String(q ?? '').trim().toLowerCase();
      if (!needle) return [];
      return FAKE.filter((m) => m.title.toLowerCase().includes(needle)).map((m) => ({
        id: m.id, dir: m.dir, title: m.title,
        notesHit: null, transcriptHit: null,
        noteHit: m.title.replace(new RegExp('(' + needle.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'i'), '\\u0001$1\\u0002'),
        score: -1,
      }));
    },
    saveMeeting: async (p) => ({
      dir: '/m/new',
      meta: { durationSeconds: Math.max(0, (p.endedAt - p.startedAt) / 1000),
        tracks: { mic: { silent: false, voicedSeconds: 12 }, system: { silent: false, voicedSeconds: 9 } } },
    }),
    saveNote: async (_dir, text) => ({ chars: (text ?? '').length }),
    deleteMeeting: async () => true,
    transcribe: async () => ({ count: 5, ok: true, echoes: 0 }),
    copyPrompt: async () => ({ words: 3200 }),
    openProvider: async () => {},
    openFolder: async () => {},
    modelsReady: async () => true,

    /* settings */
    settingsGet: async () => ({ ...settings }),
    settingsSet: async (patch) => {
      for (const k of SETTING_KEYS) if (patch && k in patch) settings[k] = patch[k];
      return { ...settings };
    },

    /* calendar */
    calendarRefresh: async () => {
      await new Promise((r) => setTimeout(r, 400));
      emit(listeners.calendar, { fetchedAt: new Date().toISOString() });
      return { ok: true, error: null, fetchedAt: new Date().toISOString(),
        count: AGENDA.reduce((n, d) => n + d.events.length, 0) };
    },
    calendarUpcoming: async ({ days = 7 } = {}) => AGENDA.slice(0, Math.max(1, days)),
    calendarEventNow: async () => EVENT_NOW,
    onCalendarUpdated: subscribe(listeners.calendar),

    /* live transcript: no audio is read, segments arrive on a timer */
    liveStart: async () => {
      clearLive();
      emit(listeners.status, { state: 'loading', message: 'Loading the speech model', progress: 0.2 });
      liveTimers.push(setTimeout(() => emit(listeners.status, { state: 'ready', message: 'Listening', progress: 1 }), 600));
      LIVE_SEGMENTS.forEach((s, i) => {
        liveTimers.push(setTimeout(() => emit(listeners.segment, s), 1200 + i * 1800));
      });
      return { ok: true, error: null };
    },
    livePush: () => {},
    liveStop: async () => { clearLive(); return { segments: LIVE_SEGMENTS }; },
    onLiveSegment: subscribe(listeners.segment),
    onLiveStatus: subscribe(listeners.status),

    appVersion: async () => APP_VERSION,
  };
`;

const server = http.createServer(async (req, res) => {
  try {
    const url = pathnameOf(req.url);
    if (url === null) return res.writeHead(400).end('bad request');

    if (url === '/app/index.html' || url === '/') {
      let html = await fs.readFile(path.join(APP, 'index.html'), 'utf8');
      // A classic script runs at parse time, so the stub is in place before
      // renderer.js, which is deferred by virtue of being a module.
      html = html.replace('<script type="module"', '<script src="/__api-stub.js"></script><script type="module"');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(html);
    }
    if (url === '/__api-stub.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(STUB_JS);
    }
    // The renderer imports its siblings as modules; serve anything under app/,
    // by either the /app/ path or the bare filename the module specifier produces.
    const js = /^\/(?:app\/)?([\w.-]+\.js)$/.exec(url);
    if (js) {
      const file = resolveInside(APP, js[1]);
      if (!file) return res.writeHead(403).end('forbidden');
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(await fs.readFile(file, 'utf8'));
    }
    // Vendored fonts, so the preview shows the real typefaces rather than a
    // fallback. The app loads these from disk; here they need a route.
    if (url.startsWith('/app/')) {
      const file = resolveInside(APP, url.slice('/app/'.length));
      if (!file) return res.writeHead(403).end('forbidden');
      const body = await fs.readFile(file).catch(() => null);
      if (!body) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      return res.end(body);
    }
    // The landing page, served raw (no window.api stub needed).
    if (url === '/docs' || url.startsWith('/docs/')) {
      const rel = url.slice('/docs'.length).replace(/^\/+/, '') || 'index.html';
      const file = resolveInside(DOCS, rel);
      if (!file) return res.writeHead(403).end('forbidden');
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      return res.end(body);
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    // A miss inside a served folder is a 404; anything else is a real fault,
    // reported without the message so paths off disk stay off the wire.
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EPERM') {
      return res.writeHead(404).end('not found');
    }
    console.error(err);
    res.writeHead(500).end('server error');
  }
});

server.listen(PORT, HOST, () => console.log(`ui preview on http://${HOST}:${PORT}`));
