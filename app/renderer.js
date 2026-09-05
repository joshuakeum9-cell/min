/*
 * Renderer entry point: the router, and nothing else.
 *
 * Capture, the note document and the transcript panel live in record.js; the
 * agenda and the meetings list in home.js; the settings form in settings-view.js.
 * This file decides which of the three views is on screen, keeps the rail in
 * step with it, and owns the handful of shortcuts that cross views.
 *
 * It lives in its own file rather than inline in index.html so the
 * Content-Security-Policy can authorise it with script-src 'self'. The inline
 * form needed a sha256 of the script text, which silently blanked the window
 * whenever anyone edited a byte and forgot to recompute it.
 *
 * Loaded as a module, so it is deferred and the DOM is parsed before it runs.
 */
import { initHome, refreshHome } from './home.js';
import { initNote, openMeeting, newNote, isRecording, startRecording } from './record.js';
import { initSettings } from './settings-view.js';

const api = window.api;
const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const setStatus = (m, cls = '') => {
  if (!statusEl) return;
  statusEl.className = cls;
  statusEl.textContent = m;
};

/* ═════════════════════════════════ views ═════════════════════════════════ */

/**
 * One section per view, one rail button per section. "My notes" shares the
 * home section because the meetings library IS the home list; it only moves
 * the eye to the list rather than the agenda.
 */
const VIEWS = {
  home: { section: 'viewHome', rail: 'navHome' },
  note: { section: 'viewNote', rail: null },
  settings: { section: 'viewSettings', rail: 'navSettings' },
};
const RAIL_BUTTONS = ['navHome', 'navNotes', 'navSettings'];

let currentView = null;

/**
 * Show one view. Returns false when the move was refused.
 *
 * A recording in progress pins the note view: navigating away would hide the
 * Stop button and the live transcript while the microphone and loopback keep
 * running, which is the one state the interface must never present as idle.
 *
 * payload for 'note': { meeting } opens a saved meeting in read mode,
 * { prefill } starts a new note from a calendar event, nothing keeps whatever
 * the note view already holds. payload.rail names the rail button to light,
 * for the two buttons that share the home section.
 */
function navigate(view, payload) {
  const target = VIEWS[view];
  if (!target) return false;

  if (view !== 'note' && isRecording()) {
    setStatus('Recording. Press Stop before leaving this note.', 'warn');
    return false;
  }

  for (const v of Object.values(VIEWS)) {
    $(v.section)?.classList.toggle('hide', v !== target);
  }
  const activeRail = payload?.rail ?? target.rail;
  for (const id of RAIL_BUTTONS) {
    $(id)?.classList.toggle('active', id === activeRail);
  }

  if (view === 'note') {
    // Two call shapes reach here: navigate('note', {meeting}) from this file,
    // and navigate('note', meeting) from the home list and from a search hit.
    // A meeting is recognised by its folder, which both shapes carry.
    const meeting = payload?.meeting ?? (payload?.dir ? payload : null);
    if (meeting) openMeeting(meeting);
    else if (payload && 'prefill' in payload) newNote(payload.prefill);
  }

  currentView = view;

  // Runs after the section is visible, so anything measuring itself sees real
  // dimensions rather than the zeros of a display:none subtree.
  if (view === 'home') refreshHome();
  return true;
}

// The other modules navigate through this rather than importing the router,
// which would make renderer.js and record.js import each other.
window.__min = { navigate };

/* ══════════════════════════════ rail + keys ══════════════════════════════ */

function focusAsk() {
  const ask = $('ask');
  if (!ask) return;
  ask.focus();
  ask.select();
}

$('navHome')?.addEventListener('click', () => navigate('home'));
$('navNotes')?.addEventListener('click', () => {
  if (!navigate('home', { rail: 'navNotes' })) return;
  $('noteList')?.scrollIntoView({ block: 'start' });
});
$('navSettings')?.addEventListener('click', () => navigate('settings'));
$('newNote')?.addEventListener('click', () => {
  if (isRecording()) {
    setStatus('Recording. Press Stop before starting another note.', 'warn');
    return;
  }
  newNote(undefined);
  navigate('note');
});
$('searchPill')?.addEventListener('click', () => {
  if (navigate('home')) focusAsk();
});

window.addEventListener('keydown', (e) => {
  // Ctrl+K (Cmd+K on a Mac) is the one global shortcut. A full palette is P1;
  // landing in the search bar covers the common case.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (navigate('home')) focusAsk();
    return;
  }
  if (e.key === 'Escape') {
    if (isRecording()) return;
    // Escape inside the search bar drops focus first, and a second press goes
    // home, so a stray key does not yank the user out of the middle of a search.
    if (document.activeElement === $('ask') && currentView === 'home') {
      $('ask').blur();
      return;
    }
    if (currentView !== 'home') navigate('home');
  }
});

// The audio only exists in memory until Stop is pressed. Closing the window
// mid-recording would lose the whole meeting, so make the browser ask first.
window.addEventListener('beforeunload', (e) => {
  if (isRecording()) { e.preventDefault(); e.returnValue = ''; }
});

/* ═════════════════════════════════ boot ══════════════════════════════════ */

/**
 * The write-up provider used to live in localStorage, which the settings file
 * replaced so the preference sits with the process that owns it. Carry the old
 * value across once, then remove the key so this never runs twice.
 */
async function migrateProvider(settings) {
  let old = null;
  try { old = localStorage.getItem('provider'); } catch { return settings; }
  if (old === null) return settings;
  try { localStorage.removeItem('provider'); } catch { /* best effort */ }
  if (typeof old !== 'string' || old === settings.provider) return settings;
  try {
    return await api.settingsSet({ provider: old });
  } catch {
    return settings;
  }
}

async function boot() {
  let settings = {};
  try {
    settings = (await api.settingsGet()) ?? {};
    settings = await migrateProvider(settings);
  } catch (e) {
    setStatus('Settings could not be read: ' + e.message, 'warn');
  }

  // The interface is light only; the attribute is here so a stylesheet can key
  // off it without another round trip to settings later.
  document.documentElement.dataset.theme = 'light';

  try {
    const v = await api.appVersion();
    if (v && $('appVersion')) $('appVersion').textContent = 'v' + String(v).replace(/^v/, '');
  } catch { /* the version row is decoration */ }

  // Each module is wired on its own so a fault in one leaves the others, and
  // the router, working.
  const wire = (name, fn) => {
    try { fn(); } catch (e) { console.error(`${name} failed to initialise`, e); }
  };
  wire('home', () => initHome({ api, navigate, onStatus: setStatus, settings }));
  wire('note', () => initNote({ api, onStatus: setStatus }));
  wire('settings', () => initSettings({ api }));

  /*
   * "Take notes" on a meeting prompt: open a note for that meeting and start.
   * Wired here rather than in home.js because it must work from any view, and
   * the router is the only thing that can move between them.
   */
  api?.onMeetingAlertTake?.((ev) => {
    if (!ev) return;
    if (isRecording()) {
      setStatus('Already recording. Press Stop before starting that meeting.', 'warn');
      return;
    }
    navigate('note', { prefill: { calendarEvent: ev, title: ev.title } });
    if (!startRecording()) setStatus('Could not start recording that meeting.', 'warn');
  });

  navigate('home');
}

boot();
