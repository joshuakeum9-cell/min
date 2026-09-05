/**
 * MIN · M1, the recorder.
 *
 * Main process. Owns the window, the loopback grant, and everything that touches
 * disk. The renderer captures audio and hands over finished PCM; it never writes
 * files itself.
 *
 * Layout on disk, one folder per meeting, exactly what the user sees:
 *   ~/Meetings/2026-09-02-1930-untitled/
 *     my-notes.md      what you typed, verbatim, never rewritten
 *     mic.wav          your microphone            ] deleted once
 *     system.wav       everyone else on the call  ] transcription succeeds
 *     meeting.json     timings, devices, gap markers, integrity check
 */

import { app, BrowserWindow, Menu, screen, session, desktopCapturer, ipcMain, shell, clipboard } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createSettings } from './settings.js';
import { createCalendarStore } from './calendar-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEETINGS_DIR = path.join(os.homedir(), 'Meetings');

/**
 * Every filesystem path in this file arrives as a plain string over IPC, and
 * the main process cannot tell one the UI produced from one a compromised
 * renderer invented. Two handlers hand that string straight to the OS with the
 * user's own privileges: shell.openPath is ShellExecute on Windows, so a path
 * to an .exe, .bat or .lnk gets run, and shell.trashItem recurses through a
 * directory. Nothing here acts on a path until it resolves to something strictly
 * inside MEETINGS_DIR.
 *
 * The root itself is a special case, and it is only ever allowed on request.
 * open-folder needs it, because opening the library is exactly what its button
 * does. delete-meeting must not have it: one IPC call naming the root would
 * otherwise send every meeting the user owns to the recycle bin, so it takes the
 * default and only accepts a folder below the root.
 *
 * The trailing separator is the whole point of the prefix test: without it a
 * sibling folder named MeetingsEvil passes as inside Meetings. The comparison
 * is folded on Windows because the filesystem is case-insensitive.
 *
 * path.resolve collapses ".." but does not follow links, so a junction planted
 * inside the folder would still pass. Planting one already needs write access
 * to the user's disk.
 */
const ROOT = path.resolve(MEETINGS_DIR);
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function confine(p, { allowRoot = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('No meeting folder given.');
  const full = path.resolve(p);
  if (fold(full) === fold(ROOT)) {
    if (allowRoot) return full;
    throw new Error(`Refused: ${full} is the whole meetings library, not one meeting.`);
  }
  if (!fold(full).startsWith(fold(ROOT) + path.sep)) {
    throw new Error(`Refused: ${full} is outside ${ROOT}.`);
  }
  return full;
}

// Point the model loader at a writable per-user directory before anything
// imports it. Inside a packaged app the source tree is a read-only asar.
if (!process.env.MIN_MODELS_DIR) {
  process.env.MIN_MODELS_DIR = path.join(app.getPath('userData'), 'models');
}

/*
 * No application menu. Electron ships a default File / Edit / View / Window bar,
 * and that strip is the single strongest visual cue that a window is a text
 * editor rather than an application: it is exactly what Notepad wears. Clipboard
 * and undo shortcuts inside text fields are handled by Chromium itself, not by
 * these menu roles, so removing the bar costs nothing. Verified by driving
 * select-all, cut, paste and undo in the real window with the menu removed.
 */
Menu.setApplicationMenu(null);

/* ------------------------------------------------------------------- window */

let win = null;

/*
 * Where a link in the interface is allowed to go. Exact hosts, never a suffix
 * match: "github.com.example.com" is a different site and must not pass, and
 * neither should a subdomain nobody has looked at.
 */
const LINK_HOSTS = new Set(['github.com']);

function allowedLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'https:' && LINK_HOSTS.has(u.hostname);
}

/**
 * Keep every window on its own page and send real links to the real browser.
 *
 * Without this, an anchor with target="_blank" makes Electron open a second
 * BrowserWindow inside MIN, so the About tab's GitHub link rendered a live web
 * page in a frameless window with no address bar, no back button and no way to
 * tell what it was. Allow-listed links go to the user's browser instead, and
 * everything else is refused: nothing here is a browser.
 *
 * will-navigate covers the same in place. A window navigating away from its own
 * file is either a bug or someone steering the renderer somewhere it should not
 * go, and neither is worth honouring.
 */
function externalOnly(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedLink(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (evt, url) => {
    evt.preventDefault();
    if (allowedLink(url)) shell.openExternal(url).catch(() => {});
  });
}

function createWindow() {
  win = new BrowserWindow({
    // A 420px always-on-top strip reads as a sticky note whatever the styling.
    // The window is now a document window: rail, agenda and a centred column.
    // Staying on top while not recording is the behaviour of a widget, so it is
    // off by default and applied only around a recording, when the setting asks.
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: 'MIN',
    // The renderer's --surface. Anything else flashes in the gap between the
    // window appearing and the first paint.
    backgroundColor: '#f7f7f2',
    alwaysOnTop: false,
    // sandbox is left at Electron's default, on. That constrains preload.cjs:
    // it must stay CommonJS and stay on Electron's renderer-safe exports, since
    // a sandboxed preload cannot require arbitrary Node modules.
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Grant system-audio loopback. Without a handler, getDisplayMedia is refused
  // outright. The 4x4 video track is discarded immediately in the renderer, it
  // exists only because an audio-only display capture is not permitted.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  // The floating indicator is an accessory of this window: it reports what this
  // window is recording and every command it raises is delivered here. Left
  // alive on its own it would be an always-on-top pill with nothing behind it,
  // and on Windows it would also hold the process open past the last real
  // window, since window-all-closed would never fire.
  win.on('closed', () => {
    win = null;
    destroyIndicator();
  });

  // Drives the floating indicator: hidden while this window is in front.
  win.on('focus', syncIndicatorVisibility);
  win.on('blur', syncIndicatorVisibility);
  win.on('minimize', syncIndicatorVisibility);
  win.on('restore', syncIndicatorVisibility);

  externalOnly(win.webContents);
  win.loadFile(path.join(HERE, 'index.html'));
  return win;
}

/* --------------------------------------------------------------------- wav */

/**
 * 16-bit PCM WAV. Written by hand because the alternative is a dependency for
 * 44 bytes of header.
 */
function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);

  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/* ------------------------------------------------------------------ naming */

function folderName(startedAt, title) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}`;
  const slug =
    (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'untitled';
  return `${stamp}-${slug}`;
}

async function uniqueDir(base) {
  let dir = base;
  let n = 2;
  for (;;) {
    try {
      await fsp.mkdir(dir, { recursive: false });
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      dir = `${base}-${n++}`;
    }
  }
}

/* --------------------------------------------------------------------- ipc */

ipcMain.handle('save-meeting', async (_evt, payload) => {
  const { startedAt, endedAt, title, notes, sampleRate, mic, system, timeline, calendarEvent } = payload;

  // Built from a slug here rather than taken from the renderer, but it goes
  // through the same gate, and the gate runs before anything is created so no
  // filesystem call below acts on an unchecked path. uniqueDir only appends a
  // counter to this name, so whatever folder it settles on has the checked parent.
  const base = confine(path.join(MEETINGS_DIR, folderName(startedAt, title)));

  await fsp.mkdir(MEETINGS_DIR, { recursive: true });
  const dir = await uniqueDir(base);

  const micF32 = new Float32Array(mic.buffer, mic.byteOffset, mic.byteLength / 4);
  const sysF32 = new Float32Array(system.buffer, system.byteOffset, system.byteLength / 4);

  await Promise.all([
    fsp.writeFile(path.join(dir, 'mic.wav'), encodeWav(micF32, sampleRate)),
    fsp.writeFile(path.join(dir, 'system.wav'), encodeWav(sysF32, sampleRate)),
    fsp.writeFile(path.join(dir, 'my-notes.md'), (notes ?? '').trimEnd() + '\n'),
  ]);

  const durationSeconds = (endedAt - startedAt) / 1000;
  const meta = {
    schema: 1,
    title: title || 'Untitled',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: +durationSeconds.toFixed(2),
    sampleRate,
    tracks: {
      mic: trackMeta(micF32, sampleRate, durationSeconds),
      system: trackMeta(sysF32, sampleRate, durationSeconds),
    },
    timeline,
    // The calendar occurrence this recording was auto-titled from, when there
    // was one. library.js reads the attendee list back out of here for the
    // home rows, so the shape matters: see calendar.js for the fields.
    calendarEvent: calendarEvent && typeof calendarEvent === 'object' ? calendarEvent : null,
    audioDisposition: 'kept: delete after transcription succeeds',
    transcript: null,
  };

  await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify(meta, null, 2) + '\n');
  return { dir, meta };
});

/**
 * Per-track integrity. `silent` is the release gate: a recording where one side
 * never produced signal is the signature failure of this whole subsystem, and it
 * otherwise reports success.
 */
function trackMeta(samples, sampleRate, wallSeconds) {
  let peak = 0;
  let sumSq = 0;
  let voiced = 0;
  const window = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sumSq += samples[i] * samples[i];
  }
  for (let i = 0; i + window <= samples.length; i += window) {
    let w = 0;
    for (let k = 0; k < window; k++) w += samples[i + k] * samples[i + k];
    if (Math.sqrt(w / window) > 0.002) voiced++;
  }
  const capturedSeconds = samples.length / sampleRate;
  return {
    capturedSeconds: +capturedSeconds.toFixed(3),
    deficitSeconds: +(wallSeconds - capturedSeconds).toFixed(3),
    peak: +peak.toFixed(5),
    rms: +Math.sqrt(sumSq / Math.max(1, samples.length)).toFixed(5),
    voicedSeconds: +((voiced * window) / sampleRate).toFixed(2),
    silent: peak < 1e-4,
  };
}

/**
 * Transcribe, then hand the write-up prompt to the clipboard.
 *
 * Both steps run here rather than in the renderer because both touch disk and
 * spawn processes. Transcription itself forks per-track workers, so the main
 * process only orchestrates and the window stays responsive.
 */
// Two runs on one meeting race each other to the same files, and the loser can
// overwrite a good transcript with an empty one after the first run has already
// deleted the audio. Coalesce rather than reject: a second click should join the
// run in progress, not fail.
const inFlight = new Map();

ipcMain.handle('transcribe', async (_evt, dir) => {
  const key = confine(dir);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const { transcribeMeeting } = await import('./transcribe.js');
    const r = await transcribeMeeting(key, { threads: 4, quiet: true });
    await reindexSoon();
    return {
      count: r.count,
      ok: r.ok,
      empty: r.empty,
      audioKept: r.audioKept,
      echoes: r.meta?.transcript?.echoesSuppressed?.count ?? 0,
      failed: (r.meta?.transcript?.perTrack ?? []).filter((t) => !t.ok).map((t) => t.speaker),
    };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
});

ipcMain.handle('copy-prompt', async (_evt, dir) => {
  const { promptForMeeting } = await import('./prompt.js');
  const { text } = await promptForMeeting(confine(dir));
  clipboard.writeText(text);
  return { words: text.split(/\s+/).length };
});


/* ----------------------------------------------------------------- library */

// The index is a disposable cache, so it lives in userData rather than beside
// the meetings. That keeps the user's folder to readable files only, and keeps
// a database out of anything they might sync to Dropbox or iCloud.
const INDEX_PATH = path.join(app.getPath('userData'), 'index.db');

ipcMain.handle('list-meetings', async () => {
  const { listMeetings } = await import('./library.js');
  const all = await listMeetings();
  // The renderer only needs enough to draw the list; bodies are fetched on click.
  return all.map((m) => ({
    id: m.id, dir: m.dir, title: m.title, startedAt: m.startedAt,
    durationSeconds: m.durationSeconds, transcribed: m.transcribed,
    written: m.written, hasAudio: m.hasAudio,
    noteChars: (m.notes ?? '').trim().length,
  }));
});

ipcMain.handle('read-meeting', async (_evt, dir) => {
  const { readMeeting } = await import('./library.js');
  return readMeeting(confine(dir));
});

/**
 * Rebuilding on every keystroke re-read every meeting from disk. Rebuild on the
 * events that actually change the corpus instead, coalescing concurrent calls.
 */
let indexJob = null;
async function reindexSoon() {
  if (indexJob) return indexJob;
  const { reindex } = await import('./library.js');
  indexJob = reindex(INDEX_PATH).finally(() => { indexJob = null; });
  return indexJob;
}

ipcMain.handle('search', async (_evt, q) => {
  const { search } = await import('./library.js');
  if (!indexReady) { await reindexSoon(); indexReady = true; }
  return search(INDEX_PATH, q);
});

let indexReady = false;

/** Save the write-up pasted back from the assistant. */
ipcMain.handle('save-note', async (_evt, dir, text) => {
  const target = confine(dir);
  const clean = (text ?? '').trim();
  if (!clean) throw new Error('Nothing to save.');
  await fsp.writeFile(path.join(target, 'note.md'), clean + '\n');

  // The catch has to cover the parse too. Attached to the read alone, a transient
  // EBUSY yields '{}' and this write-back destroys the whole record while the UI
  // reports success.
  const metaPath = path.join(target, 'meeting.json');
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`note.md saved, but meeting.json could not be read (${err.message}) so it was left untouched.`);
    }
    meta = {};
  }
  meta.note = { at: new Date().toISOString(), chars: clean.length, source: 'pasted' };
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  return { chars: clean.length };
});

/**
 * Save the notes the user typed during the call. A different file from the
 * write-up above: my-notes.md is the skeleton the write-up is built from, so
 * losing one to the other would destroy the input to the whole product.
 */
ipcMain.handle('save-notes', async (_evt, dir, text) => {
  const target = confine(dir);
  await fsp.writeFile(path.join(target, 'my-notes.md'), (text ?? '').trimEnd() + '\n');
  return { chars: (text ?? '').length };
});

/**
 * Deletion goes to the recycle bin, never a hard unlink. A meeting is a record of
 * a real conversation and the user may want it back.
 */
ipcMain.handle('delete-meeting', async (_evt, dir) => {
  await shell.trashItem(confine(dir));
  await reindexSoon();
  return true;
});

/**
 * Open an assistant's web chat in the user's normal browser.
 *
 * This is the honest version of "log in to your AI account". Consumer
 * subscriptions expose no OAuth and no API to third-party apps, so the app never
 * touches credentials at all, it hands the browser a URL, where the user is
 * already signed in, and the prompt is already on their clipboard. Nothing to
 * configure, nothing to revoke, and it works with every provider equally.
 */
const PROVIDER_URLS = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  copilot: 'https://copilot.microsoft.com/',
  perplexity: 'https://www.perplexity.ai/',
  mistral: 'https://chat.mistral.ai/chat',
  grok: 'https://grok.com/',
  deepseek: 'https://chat.deepseek.com/',
};

ipcMain.handle('open-provider', async (_evt, id) => {
  const url = PROVIDER_URLS[id];
  // Only ever open a URL from this fixed table, never one built from user or
  // file content.
  if (!url) throw new Error(`Unknown provider: ${id}`);
  await shell.openExternal(url);
  return url;
});

ipcMain.handle('open-folder', async (_evt, dir) => {
  // The one caller allowed to name the library root: with no dir it opens the
  // whole folder, which is the point of the button.
  const target = confine(dir ?? MEETINGS_DIR, { allowRoot: true });

  // Confinement alone is not enough here. openPath on a file runs it through
  // the shell, so a .bat sitting in the meetings folder would execute on a
  // click. Only ever open a directory.
  let st;
  try {
    st = await fsp.stat(target);
  } catch {
    throw new Error(`Cannot open ${target}: it is not there.`);
  }
  if (!st.isDirectory()) throw new Error(`Refused: ${target} is not a folder.`);

  // openPath reports failure by returning a message rather than throwing, and
  // swallowing it left the button looking as though it had worked.
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
  return target;
});

ipcMain.handle('models-ready', async () => {
  const { modelReady } = await import('../m0/lib/models.js');
  return (await modelReady('parakeet-v3')) && (await modelReady('silero-vad'));
});

ipcMain.handle('meetings-dir', () => MEETINGS_DIR);

ipcMain.handle('set-always-on-top', (_evt, on) => {
  win?.setAlwaysOnTop(Boolean(on));
  return Boolean(on);
});

ipcMain.handle('app-version', () => app.getVersion());

/* ---------------------------------------------------------------- settings */

const settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));

ipcMain.handle('settings-get', () => settings.all());
ipcMain.handle('settings-set', (_evt, patch) => settings.set(patch));

/* --------------------------------------------------------------- indicator */

/**
 * The floating recording indicator, the nub.
 *
 * The problem it solves: the moment the user switches to Zoom or Teams, MIN is
 * behind another window and every in-app sign that it is recording is hidden.
 * The nub is a second, tiny window that outlives that switch, so the answer to
 * "is this being captured?" is always one glance away and never requires
 * alt-tabbing back.
 *
 * It is a separate BrowserWindow rather than page chrome because nothing drawn
 * inside the main window can be seen while a different application is in front.
 * That is also why it takes the 'screen-saver' always-on-top level: the normal
 * level sits below other applications' floating panels, and a video call is
 * exactly the kind of app that ships them.
 */
const INDICATOR_WIDTH = 132;
const INDICATOR_HEIGHT = 44;
// Far enough off the corner to clear the taskbar's rounded end and any dock.
const INDICATOR_MARGIN = 24;

let indicator = null;
let indicatorReady = false;
let indicatorMoveTimer = null;

// The last state the renderer reported, kept so a nub created part-way through
// a recording, or one whose page finishes loading a beat later, has something to
// draw before the next tick arrives.
let recordingState = { recording: false, you: 0, them: 0, title: '' };

/**
 * Everything here crosses from the renderer, so nothing is trusted: levels are
 * clamped to the 0..1 the bars expect and a NaN becomes 0, because a NaN would
 * propagate into a CSS length and blank the glyph. The title is truncated
 * because it is a meeting name the user typed, and the nub is 132px wide.
 */
function cleanRecordingState(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const level = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return {
    recording: Boolean(p.recording),
    you: level(p.you),
    them: level(p.them),
    title: typeof p.title === 'string' ? p.title.slice(0, 120) : '',
  };
}

/** "x,y" from settings, or null when unset or malformed. */
function savedIndicatorPosition() {
  const raw = settings.get('indicatorPosition');
  if (typeof raw !== 'string') return null;
  const m = /^\s*(-?\d{1,6})\s*,\s*(-?\d{1,6})\s*$/.exec(raw);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/**
 * Pull a point back onto a screen that is actually attached. Used both when the
 * nub opens on a saved position and on every step of a manual drag, so it can
 * never be parked somewhere it cannot be reached from.
 */
function clampToDisplay(x, y) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(x, area.x, area.x + area.width - INDICATOR_WIDTH),
    y: clamp(y, area.y, area.y + area.height - INDICATOR_HEIGHT),
  };
}

/**
 * Where to open the nub: the user's saved spot when there is one, otherwise the
 * bottom-right of the primary work area.
 *
 * The saved point is clamped against the display nearest to it rather than the
 * primary one. Someone who docks a laptop drags the nub onto the second screen;
 * undocking retires that screen and leaves the saved coordinates describing a
 * desktop that no longer exists. Nearest-display resolves to a screen that is
 * still attached, and the clamp then pulls the window back onto it, so an
 * unplugged monitor cannot strand the only recording indicator off screen.
 */
function indicatorPosition() {
  const saved = savedIndicatorPosition();
  if (saved) return clampToDisplay(saved.x, saved.y);

  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - INDICATOR_WIDTH - INDICATOR_MARGIN,
    y: area.y + area.height - INDICATOR_HEIGHT - INDICATOR_MARGIN,
  };
}

/**
 * 'moved' fires continuously through a drag, and settings.set writes the file
 * atomically each time, so persisting on the raw event would be hundreds of
 * write-and-rename pairs for one gesture. Only the position the drag ends on
 * matters.
 */
function rememberIndicatorPosition() {
  if (indicatorMoveTimer) clearTimeout(indicatorMoveTimer);
  indicatorMoveTimer = setTimeout(() => {
    indicatorMoveTimer = null;
    if (!indicator || indicator.isDestroyed()) return;
    const [x, y] = indicator.getPosition();
    try {
      settings.set({ indicatorPosition: `${Math.round(x)},${Math.round(y)}` });
    } catch { /* a position is a convenience; a full disk must not break recording */ }
  }, 400);
}

function sendIndicatorState() {
  if (!indicator || indicator.isDestroyed() || !indicatorReady) return;
  indicator.webContents.send('indicator-state', recordingState);
}

function createIndicator() {
  if (indicator && !indicator.isDestroyed()) return indicator;

  const { x, y } = indicatorPosition();
  indicatorReady = false;
  indicator = new BrowserWindow({
    x,
    y,
    width: INDICATOR_WIDTH,
    height: INDICATOR_HEIGHT,
    frame: false,
    transparent: true,
    // A shadow on a transparent window paints a grey box around the pill on
    // Windows, which is the "floating white rectangle" bug in miniature.
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // It is not a document, so it has no business in the taskbar or alt-tab.
    skipTaskbar: true,
    /*
     * The property that keeps a click on the pill off the user's call: a
     * focusable window takes foreground the instant it is touched, which is the
     * one thing this window must never do. Measured on Windows: with
     * focusable:false the other app stayed in front, and an otherwise identical
     * focusable:true window took foreground immediately.
     *
     * It costs the drag region: -webkit-app-region:drag is inert here (a
     * synthetic press-move-release left the window exactly where it started).
     * But the page does still receive mousedown and mousemove with real screen
     * coordinates, so indicator.js drags by hand through 'indicator-move' below,
     * and that was measured moving the window by exactly the requested delta.
     */
    focusable: false,
    // Shown with showInactive once the page has painted, so the pill never
    // appears as an empty transparent rectangle.
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'indicator-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Above ordinary always-on-top windows, which is where video call apps put
  // their own floating controls.
  indicator.setAlwaysOnTop(true, 'screen-saver');
  // A meeting does not stop being recorded because the user swiped to another
  // desktop or put the call full screen.
  indicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  indicator.webContents.on('did-finish-load', () => {
    indicatorReady = true;
    sendIndicatorState();
    syncIndicatorVisibility();
  });

  indicator.on('moved', rememberIndicatorPosition);
  indicator.on('closed', () => {
    indicator = null;
    indicatorReady = false;
  });

  externalOnly(indicator.webContents);
  indicator.loadFile(path.join(HERE, 'indicator.html'));
  return indicator;
}

/*
 * The nub exists for the whole recording, but it is only worth SEEING once MIN
 * is behind something else. On top of the note it belongs to it is clutter, and
 * an always-on-top window covering its own parent is the kind of detail that
 * makes an app feel unfinished. showInactive rather than show, always: this
 * window must never take focus, least of all off a live call.
 */
function syncIndicatorVisibility() {
  if (!indicator || indicator.isDestroyed() || !indicatorReady) return;
  const mainInFront = Boolean(win) && !win.isDestroyed() && win.isFocused() && !win.isMinimized();
  if (mainInFront) {
    if (indicator.isVisible()) indicator.hide();
  } else if (!indicator.isVisible()) {
    indicator.showInactive();
  }
}

/**
 * Pull a live nub back onto a screen that still exists.
 *
 * The open-time clamp in indicatorPosition only runs when the nub is created. A
 * monitor unplugged mid-recording, or a resolution change, can leave the one
 * window the user still sees sitting on a desktop that is no longer there.
 */
function reclampIndicator() {
  if (!indicator || indicator.isDestroyed()) return;
  const [x, y] = indicator.getPosition();
  const to = clampToDisplay(x, y);
  if (to.x !== x || to.y !== y) indicator.setPosition(to.x, to.y);
}

function destroyIndicator() {
  if (indicatorMoveTimer) {
    clearTimeout(indicatorMoveTimer);
    indicatorMoveTimer = null;
  }
  if (indicator && !indicator.isDestroyed()) indicator.destroy();
  indicator = null;
  indicatorReady = false;
}

/**
 * `on`, not `handle`: this arrives up to a dozen times a second while recording
 * and the renderer has nothing to do with the answer.
 *
 * The nub's whole lifetime hangs off this one signal, so there is no second
 * source of truth about whether it should exist: it appears on the first
 * recording=true and is gone on recording=false, which covers a manual stop and
 * every auto-stop the recorder decides on by itself.
 */
ipcMain.on('recording-state', (evt, payload) => {
  // Only the note window drives this. Any other sender is either a bug or a
  // page that has no business creating an always-on-top window.
  if (!win || win.isDestroyed() || evt.sender !== win.webContents) return;

  recordingState = cleanRecordingState(payload);
  if (recordingState.recording) {
    createIndicator();
    sendIndicatorState();
  } else {
    destroyIndicator();
  }
});

/**
 * The two things the nub can ask for. 'focus' is handled here because it is
 * about windows; 'stop' is a decision about the recording, which only the note
 * view knows how to make, so it is forwarded rather than acted on.
 *
 * The sender check matches the one on 'recording-state': only the nub may raise
 * these, and it is the only page whose preload can send them.
 */
ipcMain.on('indicator-command', (evt, command) => {
  if (command !== 'focus' && command !== 'stop') return;
  if (!indicator || indicator.isDestroyed() || evt.sender !== indicator.webContents) return;
  if (!win || win.isDestroyed()) return;

  if (command === 'focus') {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win.webContents.send('indicator-command', command);
});

/**
 * Manual drag. -webkit-app-region:drag is inert on a focusable:false window
 * (measured on Windows), and focusable:false is what stops a click on the pill
 * pulling focus off the call, so the page tracks the pointer itself and asks for
 * the moves. Clamped to a live display for the same reason a saved position is:
 * a pill dragged off the edge has no keyboard path back.
 */
ipcMain.on('indicator-move', (evt, x, y) => {
  if (!indicator || indicator.isDestroyed() || evt.sender !== indicator.webContents) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const { x: cx, y: cy } = clampToDisplay(Math.round(x), Math.round(y));
  indicator.setPosition(cx, cy);
  // Save from here rather than relying on the window's 'moved' event: this is a
  // programmatic move, and the debounce means a whole drag still writes once.
  rememberIndicatorPosition();
});

/* ---------------------------------------------------------------- calendar */

/**
 * The calendar URL is a bearer credential: anyone holding it can read the whole
 * calendar forever. It is never logged and never leaves this process except in
 * settings-get, which the settings pane needs in order to show it back.
 */
const calendar = createCalendarStore({
  settings,
  cachePath: path.join(app.getPath('userData'), 'calendar-cache.json'),
  onUpdated: (summary) => win?.webContents.send('calendar-updated', summary),
});

ipcMain.handle('calendar-refresh', () => calendar.refresh());
ipcMain.handle('calendar-upcoming', (_evt, opts) => calendar.upcoming(opts?.days ?? 7));
ipcMain.handle('calendar-event-now', () => calendar.eventNow());

/* -------------------------------------------------------------------- live */

// One session at a time: the worker holds a 650 MB model, and two would race the
// same transcript. Held here rather than per-window so before-quit can reach it.
let live = null;
let liveMeta = null;

ipcMain.handle('live-start', async (_evt, opts) => {
  try {
    const { createLiveSession } = await import('./live.js');
    live?.kill();
    liveMeta = { title: opts?.title ?? '' };
    live = createLiveSession({
      onSegment: (seg) => win?.webContents.send('live-segment', seg),
      onEcho: (seg) => win?.webContents.send('live-segment', { ...seg, echo: true }),
      onReady: () => win?.webContents.send('live-status', { state: 'ready' }),
      onProgress: (p) => win?.webContents.send('live-status', { state: 'loading', progress: p }),
      onError: (err) => win?.webContents.send('live-status', {
        state: 'error',
        message: String(err?.message ?? err),
        recoverable: Boolean(err?.recoverable),
      }),
    });
    return { ok: true };
  } catch (err) {
    live = null;
    // Never fatal: recording continues and the post-recording pass still runs.
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// `on`, not `handle`: audio arrives many times a second and must never wait on a
// reply. The track is validated because it indexes into the worker's buffers.
ipcMain.on('live-push', (_evt, track, buf) => {
  if (!live) return;
  if (track !== 'you' && track !== 'them') return;
  if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength % 2) return;
  try {
    live.push(track, new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2));
  } catch { /* a dead worker is reported through live-status, not here */ }
});

/**
 * Stop, then write transcript.md from what was already transcribed during the
 * call. Reuses buildTranscript so the file is byte-identical in format to the
 * post-recording path, which is what md.js and the MCP server parse.
 */
ipcMain.handle('live-stop', async (_evt, dir) => {
  if (!live) return { ok: false, count: 0 };
  const session = live;
  live = null;
  try {
    const result = await session.stop();
    const segments = result?.segments ?? [];
    if (!dir) return { ok: result?.ok !== false, count: segments.length, segments };

    const target = confine(dir);
    const { toTranscriptResults } = await import('./live.js');
    const { buildTranscript } = await import('./transcribe.js');
    const built = buildTranscript(toTranscriptResults(segments));

    // Same rule as the post-recording path: an empty result is not a success,
    // so no transcript.md is written and the audio is kept for another try.
    if (!built.count) return { ok: false, empty: true, count: 0, segments };

    await fsp.writeFile(path.join(target, 'transcript.md'), built.text);
    const metaPath = path.join(target, 'meeting.json');
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      meta = {};
    }
    // A live worker that crashed and respawned leaves a hole: the audio that
    // played while it was restarting was never transcribed. session.stop()
    // already tells the two apart (complete is ok with no restarts), and that
    // difference decides whether the wavs may be deleted below.
    const complete = result?.complete === true;
    meta.transcript = {
      at: new Date().toISOString(),
      count: built.count,
      utterances: built.count,
      source: 'live',
      complete,
      restarts: result?.restarts ?? 0,
      error: result?.error ?? null,
      // Same reasoning as the post-recording pass: keep the suppressed lines
      // themselves, because once the audio is gone a wrong call cannot be undone.
      echoesSuppressed: { count: built.suppressed.length, segments: built.suppressed },
      title: liveMeta?.title ?? '',
    };

    // Gated exactly like the post-recording pass: the worker finished cleanly
    // AND something was recognised. Without this the wavs of a live-transcribed
    // meeting are never deleted by anything, because the post-pass skips a
    // meeting that already has a transcript.md. That is roughly 230 MB an hour,
    // kept forever, for recordings that are already fully transcribed.
    let deleted = 0;
    if (complete && built.count) {
      for (const name of ['mic.wav', 'system.wav']) {
        try {
          await fsp.rm(path.join(target, name), { force: true });
          deleted++;
        } catch { /* a locked file is not worth failing the transcript over */ }
      }
      meta.audioDisposition = 'deleted after a complete live transcript';
    } else {
      meta.audioDisposition = complete
        ? 'kept, nothing was recognised live'
        : 'kept, the live worker restarted, so the transcript may have a gap';
    }

    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
    await reindexSoon();
    return { ok: true, complete, count: built.count, deleted, segments };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), count: 0 };
  } finally {
    liveMeta = null;
  }
});

/* --------------------------------------------------------------------- app */

// The inFlight coalescing above only holds within one process, so a second copy
// of MIN defeats it outright and both runs race the same meeting's files. One
// instance only: a second launch gives its window back to the copy already open.
// A worker holds a 650 MB model and has nothing to report to once the window
// is gone, so quitting should not leave one running.
app.on('before-quit', async () => {
  // First and outside the try: a transparent always-on-top window that outlives
  // its app is the classic stray-rectangle-on-the-desktop bug, and it must not
  // depend on whether the worker modules happened to load.
  destroyIndicator();
  try {
    const { killWorkers } = await import('./transcribe.js');
    killWorkers();
    const { killLiveSessions } = await import('./live.js');
    killLiveSessions();
    calendar.stop();
  } catch { /* nothing spawned yet, or the module never loaded */ }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    // After ready: the screen module is not usable before it.
    screen.on('display-removed', reclampIndicator);
    screen.on('display-metrics-changed', reclampIndicator);
    // After the window, so the first 'calendar-updated' has somewhere to land.
    calendar.start().catch(() => { /* reported through calendar-updated */ });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
