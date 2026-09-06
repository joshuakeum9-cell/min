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

import { app, BrowserWindow, Menu, screen, session, desktopCapturer, ipcMain, shell, clipboard, powerSaveBlocker } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
// Sync, and only for the live-transcript log: it is written from inside a
// child-process event handler during a recording, where an unawaited promise
// would interleave lines from two workers.
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSettings } from './settings.js';
import { createCalendarStore } from './calendar-store.js';
import {
  nextSegment, withSegment, segmentsOf, appendTranscript, offsetSamples,
} from './meeting-schema.js';
import { pendingAlert, nextWakeMs, alertKey } from './meeting-alerts.js';

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
 * does. trash-meeting must not have it: one IPC call naming the root would
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
    /*
     * The caption is painted in the app's own ground rather than the system's.
     * The default Windows title bar is a lighter strip across the top, which
     * reads as a second surface sitting above the one the app actually uses.
     * titleBarOverlay keeps the real minimise, maximise and close buttons, so
     * nothing about window management changes; only the colour behind them
     * does. Height matches #topbar, so the buttons sit in a band the interface
     * already has rather than adding one.
     *
     * The renderer must then supply its own drag region: #topbar carries
     * -webkit-app-region:drag, and it reserves room on the right for the
     * buttons through env(titlebar-area-width).
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f7f2',
      symbolColor: '#55554f',
      height: 48,
    },
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
/**
 * The 44 bytes in front of every wav this app writes: mono, 16-bit, PCM.
 *
 * Split out because two writers need it. encodeWav below knows the length up
 * front; the streaming capture does not, and writes this with zeros, then
 * patches the same two fields once the recording stops. Sharing the header
 * means a change to the format cannot reach one writer and miss the other.
 */
const WAV_HEADER_BYTES = 44;

function wavHeader(dataBytes, sampleRate) {
  const buf = Buffer.alloc(WAV_HEADER_BYTES);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
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
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + n * 2);
  wavHeader(n * 2, sampleRate).copy(buf, 0);

  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(s * 32767), WAV_HEADER_BYTES + i * 2);
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

/**
 * meeting.json, read for a write-back.
 *
 * The catch must cover the parse as well as the read: attached to readFile
 * alone, a transient EBUSY from an antivirus scanner or a sync client yields
 * '{}' and the write-back then silently destroys the title, the timings and the
 * track integrity of every earlier segment. Same rule transcribe.js follows.
 */
async function readMeta(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'meeting.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read meeting.json (${err.message}). Refusing to overwrite it.`);
  }
}

/*
 * Stop Windows going to sleep while a recording runs.
 *
 * A laptop that sleeps mid-meeting stops feeding the capture, and because the
 * meeting's length is measured from wall time, the sleep was counted as
 * recorded audio: a lid closed for forty minutes produced a meeting claiming
 * forty extra minutes it never heard. deficitSeconds in the track metadata
 * showed it after the fact, but nothing prevented it.
 *
 * 'prevent-app-suspension' rather than 'prevent-display-sleep': the screen is
 * free to turn off, which is what a user recording a call expects, but the
 * machine stays awake enough to keep the audio graph running.
 */
let sleepBlocker = null;

function applySleepBlock(on) {
  try {
    if (on && sleepBlocker === null) {
      sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!on && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
  } catch {
    // Losing this costs a sleeping laptop a gap, not the recording. It is not
    // worth failing a meeting over.
    sleepBlocker = null;
  }
}

/* ------------------------------------------------------- capture streaming */

/*
 * Audio reaches disk while the meeting is still running.
 *
 * It used to reach disk only at Stop. Every sample sat in the renderer as
 * Float32 until then, which meant two things nobody wanted: a crash, a power
 * cut or a forced restart lost the entire meeting, and the save itself briefly
 * held two copies, so the three hours MAX_MINUTES allows peaked around 2.6 GiB
 * on a machine this app targets at 8 GB. One change fixes both. The renderer
 * hands over a few seconds at a time and releases what it handed over; this
 * appends it straight into the meeting's own wav.
 *
 * The file being written IS the final wav, not a temporary format that gets
 * converted later. Its header goes down first with zero lengths and is patched
 * when the capture finishes. That is what makes an interrupted recording
 * recoverable: every sample is already in place and only the two length fields
 * are wrong, which recoverCaptures() repairs from the file's real size.
 *
 * The part files are named, not hidden. A folder with capture-mic.part.wav in
 * it is a recording that did not finish, and that is worth being able to see.
 */
const CAPTURE_MARKER = 'capture.json';
const CAPTURE_PARTS = { mic: 'capture-mic.part.wav', system: 'capture-system.part.wav' };

/** dir -> the capture running there. At most one, because there is one recorder. */
const captures = new Map();

async function openPart(dir, name, sampleRate) {
  const file = path.join(dir, name);
  const fh = await fsp.open(file, 'w');
  await fh.write(wavHeader(0, sampleRate), 0, WAV_HEADER_BYTES, 0);
  return { file, fh, bytes: 0 };
}

/**
 * Begin writing a capture into `dir`, creating the meeting folder when this is
 * a first capture rather than a Resume.
 *
 * Failing here fails the recording, deliberately. A recording that cannot reach
 * disk cannot be saved either, and finding that out now costs the user nothing,
 * while finding it out at Stop costs them the meeting.
 */
ipcMain.handle('capture-begin', async (_evt, payload = {}) => {
  const { dir: into, startedAt, title, sampleRate, calendarEvent } = payload;
  const sr = Number(sampleRate);
  if (!Number.isFinite(sr) || sr <= 0) throw new Error('capture-begin needs a sample rate');

  let target;
  if (into) {
    target = confine(into);
    const meta = await readMeta(target);
    if (!meta) throw new Error('That meeting folder has no meeting.json, so there is nothing to resume.');
  } else {
    const base = confine(path.join(MEETINGS_DIR, folderName(startedAt, title)));
    await fsp.mkdir(MEETINGS_DIR, { recursive: true });
    target = await uniqueDir(base);
  }

  // One recorder, so a capture already open on this folder is a leftover from a
  // path that threw. Close it rather than leaking the handles.
  await closeCapture(target).catch(() => {});

  const tracks = {
    mic: await openPart(target, CAPTURE_PARTS.mic, sr),
    system: await openPart(target, CAPTURE_PARTS.system, sr),
  };
  captures.set(target, { sampleRate: sr, startedAt, tracks });

  /*
   * The marker is what makes recovery possible. meeting.json is not written
   * until Stop, so without this a folder found at the next launch would have
   * two wavs, no title, no start time and no way to tell a dead recording from
   * a half-written one.
   */
  await fsp.writeFile(path.join(target, CAPTURE_MARKER), JSON.stringify({
    startedAt, title: title ?? '', sampleRate: sr,
    resume: Boolean(into),
    calendarEvent: calendarEvent && typeof calendarEvent === 'object' ? calendarEvent : null,
  }, null, 2) + '\n');

  return { dir: target };
});

/**
 * One flush from the renderer: 16-bit PCM for one track, already in the format
 * the file wants, appended at the end.
 *
 * Never throws at the renderer. A recording that keeps going with a gap is
 * better than one that stops because a single write failed, so the failure is
 * reported in the return value and the recorder decides what to say about it.
 */
ipcMain.handle('capture-append', async (_evt, dirIn, track, bytes) => {
  const cap = captures.get(confine(dirIn));
  const t = cap?.tracks?.[track];
  if (!t) return { ok: false, error: 'no capture is open for that folder' };
  try {
    const buf = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
    await t.fh.write(buf, 0, buf.length, WAV_HEADER_BYTES + t.bytes);
    t.bytes += buf.length;
    return { ok: true, bytes: t.bytes };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

/** Patch both headers, close both handles, and forget the capture. */
async function closeCapture(dir) {
  const cap = captures.get(dir);
  if (!cap) return null;
  captures.delete(dir);
  const out = {};
  for (const [name, t] of Object.entries(cap.tracks)) {
    try {
      await t.fh.write(wavHeader(t.bytes, cap.sampleRate), 0, WAV_HEADER_BYTES, 0);
    } catch { /* the close below still leaves a file recoverCaptures can repair */ }
    try { await t.fh.close(); } catch {}
    out[name] = { file: t.file, bytes: t.bytes };
  }
  return { sampleRate: cap.sampleRate, startedAt: cap.startedAt, tracks: out };
}

/**
 * The same numbers trackMeta produces, read back off the disk rather than out
 * of an array in memory.
 *
 * Streamed in 1 MiB pieces because the whole point of writing as we go is not
 * to hold a meeting in memory, and loading it back to measure it would undo
 * that. The 20 ms voiced window straddles those pieces, so the tail of each
 * read is carried into the next; without that carry the window count drifts by
 * one per megabyte and voicedSeconds would quietly read low.
 */
async function trackMetaFromWav(file, sampleRate, wallSeconds) {
  const window = Math.max(1, Math.floor(sampleRate * 0.02));
  let peak = 0, sumSq = 0, count = 0, voiced = 0;
  let carry = new Float32Array(0);

  const fh = await fsp.open(file, 'r').catch(() => null);
  if (!fh) return trackMeta(new Float32Array(0), sampleRate, wallSeconds);
  try {
    const size = (await fh.stat()).size;
    const chunk = Buffer.alloc(1024 * 1024);
    let at = WAV_HEADER_BYTES;
    while (at < size) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - at), at);
      if (!bytesRead) break;
      at += bytesRead;
      const n = Math.floor(bytesRead / 2);
      const samples = new Float32Array(carry.length + n);
      samples.set(carry, 0);
      for (let i = 0; i < n; i++) samples[carry.length + i] = chunk.readInt16LE(i * 2) / 32767;

      for (let i = carry.length; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > peak) peak = a;
        sumSq += samples[i] * samples[i];
      }
      count += n;

      let i = 0;
      for (; i + window <= samples.length; i += window) {
        let w = 0;
        for (let k = 0; k < window; k++) w += samples[i + k] * samples[i + k];
        if (Math.sqrt(w / window) > 0.002) voiced++;
      }
      carry = samples.slice(i);
    }
  } finally {
    await fh.close().catch(() => {});
  }

  const capturedSeconds = count / sampleRate;
  return {
    capturedSeconds: +capturedSeconds.toFixed(3),
    deficitSeconds: +(wallSeconds - capturedSeconds).toFixed(3),
    peak: +peak.toFixed(5),
    rms: +Math.sqrt(sumSq / Math.max(1, count)).toFixed(5),
    voicedSeconds: +((voiced * window) / sampleRate).toFixed(2),
    silent: peak < 1e-4,
  };
}

/**
 * Finish the recordings that never got to finish themselves.
 *
 * Runs once at launch, before the window opens. A folder holding a capture
 * marker is a meeting that was interrupted: the app was killed, the machine
 * lost power, Windows restarted underneath it. The samples are on disk, so the
 * meeting is not lost unless nothing ever puts a meeting.json beside them.
 *
 * Deliberately silent about folders it cannot repair. This runs on the path to
 * showing a window, and a user who has just had a power cut should get their
 * app, with whatever could be saved already saved.
 */
async function recoverCaptures() {
  let recovered = 0;
  const dirs = await fsp.readdir(MEETINGS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MEETINGS_DIR, entry.name);
    const markerPath = path.join(dir, CAPTURE_MARKER);
    let marker;
    try {
      marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
    } catch { continue; }

    try {
      const sr = Number(marker.sampleRate) || 16000;
      const parts = {};
      let samples = 0;
      for (const [name, file] of Object.entries(CAPTURE_PARTS)) {
        const full = path.join(dir, file);
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) { parts[name] = null; continue; }
        const dataBytes = Math.max(0, stat.size - WAV_HEADER_BYTES);
        // The header is the only thing an interrupted write leaves wrong.
        const fh = await fsp.open(full, 'r+');
        await fh.write(wavHeader(dataBytes, sr), 0, WAV_HEADER_BYTES, 0);
        await fh.close();
        parts[name] = full;
        samples = Math.max(samples, Math.floor(dataBytes / 2));
      }

      if (!parts.mic || !parts.system || samples === 0) {
        // Nothing was ever captured. Clear the leftovers rather than leaving a
        // folder that will be offered as a recovery for ever.
        for (const file of Object.values(CAPTURE_PARTS)) {
          await fsp.rm(path.join(dir, file), { force: true }).catch(() => {});
        }
        await fsp.rm(markerPath, { force: true }).catch(() => {});
        continue;
      }

      const startedAt = Date.parse(marker.startedAt) || Number(marker.startedAt) || Date.now();
      // No endedAt was ever recorded, so the audio is the only witness to how
      // long this ran. Wall time and captured time are the same number here,
      // which is the honest thing to write when nothing measured the gap.
      const durationSeconds = samples / sr;
      const endedAt = startedAt + durationSeconds * 1000;
      await finalizeCapture({
        dir,
        parts,
        sampleRate: sr,
        startedAt,
        endedAt,
        durationSeconds,
        title: marker.title || '',
        notes: null,
        timeline: { deviceEvents: [], mic: {}, system: {}, recovered: true },
        calendarEvent: marker.calendarEvent ?? null,
      });
      await fsp.rm(markerPath, { force: true }).catch(() => {});
      recovered++;
    } catch {
      /*
       * Leave the folder exactly as it is. Its marker and its part files stay,
       * so the next launch tries again, and a repair that keeps failing never
       * costs the user the samples it could not assemble.
       */
    }
  }
  return recovered;
}

/**
 * Turn finished part files into a segment of a meeting, or into a new meeting.
 *
 * Shared by Stop and by recovery so both write exactly the same shape. The only
 * difference between them is that recovery has no notes and no endedAt of its
 * own, and says so rather than inventing them.
 */
async function finalizeCapture(opts) {
  const {
    dir, parts, sampleRate, startedAt, endedAt, durationSeconds,
    title, notes, timeline, calendarEvent,
  } = opts;

  const tracks = {
    mic: await trackMetaFromWav(parts.mic, sampleRate, durationSeconds),
    system: await trackMetaFromWav(parts.system, sampleRate, durationSeconds),
  };

  const meta = await readMeta(dir);
  if (meta) {
    // Another segment of a meeting that already exists.
    const existing = await fsp.readdir(dir).catch(() => []);
    const segment = nextSegment(meta, {
      startedAt, endedAt, durationSeconds, existing, tracks, timeline,
    });
    await fsp.rename(parts.mic, path.join(dir, segment.files.mic));
    await fsp.rename(parts.system, path.join(dir, segment.files.system));
    if (notes !== null) await fsp.writeFile(path.join(dir, 'my-notes.md'), (notes ?? '').trimEnd() + '\n');

    const next = withSegment(meta, segment);
    if (title) next.title = title;
    await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify(next, null, 2) + '\n');
    await reindexSoon();
    return { dir, meta: next, segment };
  }

  await fsp.rename(parts.mic, path.join(dir, 'mic.wav'));
  await fsp.rename(parts.system, path.join(dir, 'system.wav'));
  if (notes !== null) await fsp.writeFile(path.join(dir, 'my-notes.md'), (notes ?? '').trimEnd() + '\n');

  const fresh = {
    schema: 1,
    title: title || 'Untitled',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: +durationSeconds.toFixed(2),
    sampleRate,
    tracks,
    timeline,
    calendarEvent: calendarEvent && typeof calendarEvent === 'object' ? calendarEvent : null,
    audioDisposition: 'kept: delete after transcription succeeds',
    transcript: null,
  };
  await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify(fresh, null, 2) + '\n');
  await reindexSoon();
  return { dir, meta: fresh, segment: segmentsOf(fresh)[0] ?? null };
}

ipcMain.handle('save-meeting', async (_evt, payload) => {
  const { dir: into, startedAt, endedAt, title, notes, sampleRate, mic, system, timeline, calendarEvent } = payload;

  /*
   * The recorder's path. Its audio has been on disk since the capture began, so
   * there is nothing to write here: close the two files, measure them, and give
   * them their real names.
   *
   * The buffer path below is still reachable and still supported, for a caller
   * that has a whole recording in hand rather than a capture in progress. It is
   * how the harnesses make meetings, and it is the only way to save audio this
   * process did not itself write.
   */
  if (payload.streamed) {
    const target = confine(into);
    const closed = await closeCapture(target);
    if (!closed) throw new Error('No capture is open for that folder, so there is nothing to finish.');
    const durationSeconds = (endedAt - startedAt) / 1000;
    const saved = await finalizeCapture({
      dir: target,
      parts: { mic: closed.tracks.mic.file, system: closed.tracks.system.file },
      // The capture's own rate, not the payload's: the file was written at one
      // rate and its header already says so.
      sampleRate: closed.sampleRate,
      startedAt, endedAt, durationSeconds,
      title, notes: notes ?? '', timeline, calendarEvent,
    });
    // Last, so a throw above leaves the marker and the parts for recovery.
    await fsp.rm(path.join(target, CAPTURE_MARKER), { force: true }).catch(() => {});
    return saved;
  }

  const micF32 = new Float32Array(mic.buffer, mic.byteOffset, mic.byteLength / 4);
  const sysF32 = new Float32Array(system.buffer, system.byteOffset, system.byteLength / 4);
  const durationSeconds = (endedAt - startedAt) / 1000;
  const tracksOf = () => ({
    mic: trackMeta(micF32, sampleRate, durationSeconds),
    system: trackMeta(sysF32, sampleRate, durationSeconds),
  });

  /*
   * Resume. The note already exists on disk, so this capture becomes another
   * segment of it rather than a second folder. Everything about the meeting
   * except the new audio is recomputed by withSegment from the segments
   * themselves, so nothing here needs to know how to add up a meeting.
   */
  if (into) {
    const target = confine(into);
    const meta = await readMeta(target);
    if (!meta) throw new Error('That meeting folder has no meeting.json, so there is nothing to resume.');

    // The folder listing, not the metadata, decides which names are free. A run
    // that died between writing mic-2.wav and writing meeting.json leaves a file
    // the metadata does not mention, and reusing that name would lose its audio.
    const existing = await fsp.readdir(target).catch(() => []);
    const segment = nextSegment(meta, {
      startedAt, endedAt, durationSeconds, existing, tracks: tracksOf(), timeline,
    });

    await Promise.all([
      fsp.writeFile(path.join(target, segment.files.mic), encodeWav(micF32, sampleRate)),
      fsp.writeFile(path.join(target, segment.files.system), encodeWav(sysF32, sampleRate)),
      fsp.writeFile(path.join(target, 'my-notes.md'), (notes ?? '').trimEnd() + '\n'),
    ]);

    const next = withSegment(meta, segment);
    // A title typed during the second half of a meeting is still the title.
    if (title) next.title = title;
    await fsp.writeFile(path.join(target, 'meeting.json'), JSON.stringify(next, null, 2) + '\n');
    await reindexSoon();
    return { dir: target, meta: next, segment };
  }

  // Built from a slug here rather than taken from the renderer, but it goes
  // through the same gate, and the gate runs before anything is created so no
  // filesystem call below acts on an unchecked path. uniqueDir only appends a
  // counter to this name, so whatever folder it settles on has the checked parent.
  const base = confine(path.join(MEETINGS_DIR, folderName(startedAt, title)));

  await fsp.mkdir(MEETINGS_DIR, { recursive: true });
  const dir = await uniqueDir(base);

  await Promise.all([
    fsp.writeFile(path.join(dir, 'mic.wav'), encodeWav(micF32, sampleRate)),
    fsp.writeFile(path.join(dir, 'system.wav'), encodeWav(sysF32, sampleRate)),
    fsp.writeFile(path.join(dir, 'my-notes.md'), (notes ?? '').trimEnd() + '\n'),
  ]);

  /*
   * Still schema 1. A meeting that is never resumed is written exactly as it
   * always was, and meeting-schema.js reads it AS a one-segment meeting, so no
   * folder on disk is ever migrated. Schema 2 appears the first time someone
   * presses Resume, and only in that folder.
   */
  const meta = {
    schema: 1,
    title: title || 'Untitled',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: +durationSeconds.toFixed(2),
    sampleRate,
    tracks: tracksOf(),
    timeline,
    // The calendar occurrence this recording was auto-titled from, when there
    // was one. library.js reads the attendee list back out of here for the
    // home rows, so the shape matters: see calendar.js for the fields.
    calendarEvent: calendarEvent && typeof calendarEvent === 'object' ? calendarEvent : null,
    audioDisposition: 'kept: delete after transcription succeeds',
    transcript: null,
  };

  await fsp.writeFile(path.join(dir, 'meeting.json'), JSON.stringify(meta, null, 2) + '\n');
  return { dir, meta, segment: segmentsOf(meta)[0] ?? null };
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
    const r = await transcribeMeeting(key, {
      threads: 4,
      quiet: true,
      stripFillers: settings.get('stripFillers') !== false,
    });
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

/**
 * Move one meeting to the operating system's recycle bin.
 *
 * shell.trashItem, not fsp.rm. A meeting is the user's only copy of something
 * they cannot re-record, so "delete" here has to mean what it means everywhere
 * else on the machine: recoverable, by them, without us. The same reason the
 * uninstaller leaves the Meetings folder alone.
 *
 * confine() first, as with every path that arrives over IPC: this one ends at a
 * recursive delete, so it is the last place to be relaxed about where it points.
 */
ipcMain.handle('trash-meeting', async (_evt, dir) => {
  const target = confine(dir);
  await shell.trashItem(target);
  // The search index still holds its text until this runs.
  await reindexSoon();
  return { ok: true, dir: target };
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
let recordingState = { recording: false, elapsed: 0, you: 0, them: 0, title: '' };

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
    // Captured seconds, sent by the renderer so there is ONE clock. The nub can
    // count for itself if this never arrives, but it is recreated whenever the
    // recording state turns on, and a window that starts counting at zero on
    // every recreation would disagree with the note it belongs to.
    elapsed: Number.isFinite(p.elapsed) && p.elapsed >= 0 ? p.elapsed : null,
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
  applySleepBlock(recordingState.recording);
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
  onUpdated: (summary) => {
    win?.webContents.send('calendar-updated', summary);
    /*
     * Look again straight away rather than waiting out the current sleep.
     * Measured: without this the first check runs before the cache has loaded,
     * finds nothing, and schedules itself a full minute out, so a meeting
     * starting in the next sixty seconds got its prompt sixty seconds late.
     * The calendar changing is exactly when the answer changes.
     */
    checkAlerts();
  },
});

ipcMain.handle('calendar-refresh', () => calendar.refresh());
ipcMain.handle('calendar-upcoming', (_evt, opts) => calendar.upcoming(opts?.days ?? 7));

/* ----------------------------------------------------------- meeting alert */

/*
 * The prompt that appears shortly before a calendar meeting, offering to take
 * notes on it.
 *
 * This is the other half of the calendar model. "+ New note" is deliberately
 * impromptu and adopts no meeting, and a Coming up row has to be found and
 * clicked, so without this there is nothing that reaches the user when a
 * meeting they meant to record is actually starting.
 */
const NOTIFY_WIDTH = 320;
// Measured in the running window rather than guessed: #card lays out at 137,
// and this was 118, which cut off the bottom of the Take notes button. The
// window has to fit the card, not the other way round, because squeezing the
// card to a round number is what produced a clipped button in the first place.
const NOTIFY_HEIGHT = 137;
const NOTIFY_MARGIN = 16;
// Long enough to notice on the way back from a coffee, short enough that a
// meeting you ignored stops nagging.
const NOTIFY_LINGER_MS = 3 * 60 * 1000;

let notifyWin = null;
let notifyReady = false;
let notifyEvent = null;      // the occurrence currently on screen
let notifyTimer = null;      // the next poll
let notifyLinger = null;     // the auto-dismiss
// Occurrences already offered. Kept for the life of the process: a prompt the
// user dismissed must not come back a minute later, and a restart is a
// reasonable place to forget.
const alertedKeys = new Set();

function createNotify() {
  if (notifyWin && !notifyWin.isDestroyed()) return notifyWin;

  const area = screen.getPrimaryDisplay().workArea;
  notifyReady = false;
  notifyWin = new BrowserWindow({
    x: area.x + area.width - NOTIFY_WIDTH - NOTIFY_MARGIN,
    y: area.y + NOTIFY_MARGIN,
    width: NOTIFY_WIDTH,
    height: NOTIFY_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    /*
     * Same reasoning as the floating indicator, and it matters more here: this
     * window appears WHILE a meeting is starting, which is the worst possible
     * moment to pull focus off a call. Measured on Windows: a focusable:false
     * window still receives mousedown and click, so its buttons work; it simply
     * cannot become foreground. The cost is that key events never reach it, so
     * the dismiss X is the only way out rather than Escape.
     */
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'notify-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notifyWin.setAlwaysOnTop(true, 'screen-saver');
  notifyWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notifyWin.on('closed', () => { notifyWin = null; notifyReady = false; });
  notifyWin.webContents.on('did-finish-load', () => {
    notifyReady = true;
    sendNotifyMeeting();
    notifyWin?.showInactive();
  });
  externalOnly(notifyWin.webContents);
  notifyWin.loadFile(path.join(HERE, 'notify.html'));
  return notifyWin;
}

function sendNotifyMeeting() {
  if (!notifyWin || notifyWin.isDestroyed() || !notifyReady || !notifyEvent) return;
  const startMs = Date.parse(notifyEvent.start);
  notifyWin.webContents.send('notify-meeting', {
    title: String(notifyEvent.title ?? '').slice(0, 200),
    start: notifyEvent.start ?? null,
    end: notifyEvent.end ?? null,
    // null, not 0, when the start will not parse: 0 is a real offset meaning
    // "starting exactly now", which is the common case, and notify.js reads it
    // as one. Number.isFinite(null) is false, so the page falls back to the
    // event's own start and then to an empty line.
    startsInMs: Number.isFinite(startMs) ? startMs - Date.now() : null,
  });
}

function closeNotify() {
  if (notifyLinger) { clearTimeout(notifyLinger); notifyLinger = null; }
  notifyEvent = null;
  if (notifyWin && !notifyWin.isDestroyed()) notifyWin.destroy();
  notifyWin = null;
  notifyReady = false;
}

/** Every event the store knows about in the next couple of days, flattened. */
function alertCandidates() {
  const flat = [];
  try {
    for (const group of calendar.upcoming(2) ?? []) {
      for (const ev of group.events ?? []) flat.push(ev);
    }
  } catch { /* the calendar is a convenience; never let it break the app */ }
  return flat;
}

/*
 * One poll, rescheduling itself. A self-rescheduling timeout rather than a
 * fixed interval because nextWakeMs knows when there is nothing to look at:
 * an empty calendar checks once a minute, and a meeting three minutes out is
 * looked at again when it is nearly due.
 */
function checkAlerts() {
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }

  const on = settings.get('meetingAlerts') !== false;
  const events = on ? alertCandidates() : [];

  /*
   * Never interrupt a recording in progress. The user is in a meeting; a card
   * about the next one is noise, and "Take notes" would be refused by the
   * renderer anyway because it will not start a second note over a live one.
   *
   * The occurrence is deliberately NOT marked as alerted here, so it can still
   * be offered when the recording stops, as long as it is inside the grace
   * window. Marking it would spend the prompt on a moment the user never saw.
   */
  const busy = recordingState.recording === true;

  if (on && !busy && !notifyEvent) {
    const due = pendingAlert(events, Date.now(), { alerted: alertedKeys });
    if (due?.event) {
      notifyEvent = due.event;
      alertedKeys.add(alertKey(due.event));
      createNotify();
      sendNotifyMeeting();
      notifyLinger = setTimeout(closeNotify, NOTIFY_LINGER_MS);
      notifyLinger.unref?.();
    }
  }

  // A short wait while busy: the recording may stop at any moment, and the
  // prompt it deferred is only useful if it comes soon after.
  const wait = busy ? 15_000 : (on ? nextWakeMs(events, Date.now()) : 60_000);
  notifyTimer = setTimeout(checkAlerts, wait);
  notifyTimer.unref?.();
}

/**
 * 'take' opens the note for this meeting in the main window and starts
 * recording it; 'dismiss' just closes. Either way the occurrence stays in
 * alertedKeys, so neither answer is asked again.
 */
ipcMain.on('notify-command', (evt, command) => {
  if (!notifyWin || notifyWin.isDestroyed() || evt.sender !== notifyWin.webContents) return;
  if (command !== 'take' && command !== 'dismiss') return;

  const ev = notifyEvent;
  closeNotify();
  if (command !== 'take' || !ev || !win || win.isDestroyed()) return;

  // The user asked for this one, so taking focus is what they wanted.
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('meeting-alert-take', ev);
});

/* -------------------------------------------------------------------- live */

// One session at a time: the worker holds a 650 MB model, and two would race the
// same transcript. Held here rather than per-window so before-quit can reach it.
let live = null;
let liveMeta = null;

/*
 * Worker stderr, appended to a file beside the settings.
 *
 * Bounded by rewriting the file once it passes the cap rather than by holding
 * the whole thing in memory: this runs during a recording, and a log must never
 * be the reason a meeting is lost. Failures here are swallowed for the same
 * reason. It is a debugging aid, not a feature.
 */
const LIVE_LOG = path.join(app.getPath('userData'), 'live-transcript.log');
const LIVE_LOG_MAX = 256 * 1024;
let liveLogChecked = false;

function appendLiveLog(line) {
  try {
    if (!liveLogChecked) {
      liveLogChecked = true;
      const size = fsSync.statSync(LIVE_LOG).size;
      if (size > LIVE_LOG_MAX) fsSync.rmSync(LIVE_LOG, { force: true });
    }
    fsSync.appendFileSync(LIVE_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* a log must never break a recording */ }
}

ipcMain.handle('live-start', async (_evt, opts) => {
  try {
    const { createLiveSession } = await import('./live.js');
    live?.kill();
    liveMeta = { title: opts?.title ?? '' };
    live = createLiveSession({
      // Read once, at the start of the recording. Changing the setting mid-call
      // would make the first half of the transcript disagree with the second.
      stripFillers: settings.get('stripFillers') !== false,
      // Where this capture sits on the meeting's clock. Zero for a first
      // recording; on a Resume it is the wall gap since the meeting began, so
      // the new lines land after the old ones instead of on top of them.
      startOffsetSamples: offsetSamples(Number(opts?.offsetSeconds) || 0),
      /*
       * The worker's stderr, and live.js's own notes about it. This was not
       * wired at all, so when live transcription failed the reason was captured
       * into a buffer in live.js and then dropped unless the worker had died
       * before it was ready. Everything else was invisible, which is why a
       * clean exit could be reported as a crash for a whole release without
       * anyone being able to say why.
       */
      onLog: (line) => appendLiveLog(line),
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
ipcMain.handle('live-stop', async (_evt, dir, segmentIndex) => {
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
    // No shifting here. The session was seeded with this segment's offset, so
    // its timestamps are already on the meeting's clock rather than its own.
    const built = buildTranscript(toTranscriptResults(segments), {
      stripFillers: settings.get('stripFillers') !== false,
    });

    // Same rule as the post-recording path: an empty result is not a success,
    // so no transcript.md is written and the audio is kept for another try.
    if (!built.count) return { ok: false, empty: true, count: 0, segments };

    const metaPath = path.join(target, 'meeting.json');
    const meta = (await readMeta(target)) ?? {};

    /*
     * Appended, never overwritten. This is the second or third Stop of one
     * meeting, and the lines from the earlier segments are already in the file;
     * writing over it would throw away the first half of the meeting. The merge
     * is by timestamp and idempotent, so a retry is a no-op rather than a
     * doubled transcript.
     */
    const file = path.join(target, 'transcript.md');
    const existing = await fsp.readFile(file, 'utf8').catch(() => '');
    await fsp.writeFile(file, appendTranscript(existing, built.text));

    // A live worker that respawned leaves a hole: the audio that played while
    // it was restarting was never transcribed. That is true of a crash and of a
    // clean early finish alike, so session.stop() counts both and reports
    // complete only when neither happened. That flag, and nothing else, decides
    // whether the wavs may be deleted below.
    const complete = result?.complete === true;
    const record = {
      at: new Date().toISOString(),
      count: built.count,
      utterances: built.count,
      source: 'live',
      complete,
      restarts: result?.restarts ?? 0,
      cleanExits: result?.cleanExits ?? 0,
      error: result?.error ?? null,
      // Same reasoning as the post-recording pass: keep the suppressed lines
      // themselves, because once the audio is gone a wrong call cannot be undone.
      echoesSuppressed: { count: built.suppressed.length, segments: built.suppressed },
      title: liveMeta?.title ?? '',
    };

    /*
     * Which audio to delete. With segments this must be the files of the
     * segment that was just captured, not mic.wav and system.wav: on a Resume
     * those two belong to the FIRST segment, whose transcript this run knows
     * nothing about, and deleting them would destroy the only copy of the first
     * half of the meeting.
     */
    const all = segmentsOf(meta);
    const here = all.find((x) => x.index === segmentIndex) ?? all[all.length - 1] ?? null;
    const files = here?.files ?? { mic: 'mic.wav', system: 'system.wav' };

    if (here) {
      here.transcript = record;
      // Kept at the top level as well: library.js, md.js, prompt.js and the MCP
      // server all read meta.transcript, and none of them know about segments.
      // It describes the meeting's transcript.md, which is now every segment.
      meta.segments = all;
    }
    meta.transcript = {
      ...record,
      count: all.reduce((n, x) => n + (x.transcript?.count ?? 0), 0) || built.count,
      complete: all.every((x) => x.transcript?.complete !== false) && complete,
      segments: all.length,
    };

    let deleted = 0;
    if (complete && built.count) {
      for (const name of [files.mic, files.system]) {
        try {
          await fsp.rm(path.join(target, name), { force: true });
          deleted++;
        } catch { /* a locked file is not worth failing the transcript over */ }
      }
      if (here) here.audio = 'deleted after a complete live transcript';
      meta.audioDisposition = 'deleted after a complete live transcript';
    } else {
      const why = complete
        ? 'kept, nothing was recognised live'
        : 'kept, the live worker restarted, so the transcript may have a gap';
      if (here) here.audio = why;
      meta.audioDisposition = why;
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
  closeNotify();
  // Patch the headers of anything still being written, so a quit mid-recording
  // leaves a playable file rather than one recovery has to repair.
  for (const dir of [...captures.keys()]) closeCapture(dir);
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
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
    /*
     * Finish any recording that was interrupted, before anything else touches
     * the meetings folder. Nothing is announced: a rescued meeting simply
     * appears in the list with its title and its length, which is what the user
     * would have had if the machine had not gone down.
     */
    recoverCaptures().catch(() => { /* every folder it cannot repair, it leaves */ });
    checkAlerts();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
