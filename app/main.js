/**
 * Taonim · M1 — the recorder.
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

import { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, clipboard } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEETINGS_DIR = path.join(os.homedir(), 'Meetings');

// Point the model loader at a writable per-user directory before anything
// imports it. Inside a packaged app the source tree is a read-only asar.
if (!process.env.TAONIM_MODELS_DIR) {
  process.env.TAONIM_MODELS_DIR = path.join(app.getPath('userData'), 'models');
}

/* ------------------------------------------------------------------- window */

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 360,
    minHeight: 420,
    title: 'Taonim',
    backgroundColor: '#101312',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Grant system-audio loopback. Without a handler, getDisplayMedia is refused
  // outright. The 4x4 video track is discarded immediately in the renderer — it
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
  const { startedAt, endedAt, title, notes, sampleRate, mic, system, timeline } = payload;

  await fsp.mkdir(MEETINGS_DIR, { recursive: true });
  const dir = await uniqueDir(path.join(MEETINGS_DIR, folderName(startedAt, title)));

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
    audioDisposition: 'kept — delete after transcription succeeds',
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
  const key = path.resolve(dir);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const { transcribeMeeting } = await import('./transcribe.js');
    const r = await transcribeMeeting(dir, { threads: 4, quiet: true });
    await reindexSoon();
    return {
      count: r.count,
      ok: r.ok,
      echoes: r.meta?.transcript?.echoesSuppressed?.count ?? 0,
      failed: (r.meta?.transcript?.perTrack ?? []).filter((t) => !t.ok).map((t) => t.speaker),
    };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
});

ipcMain.handle('copy-prompt', async (_evt, dir) => {
  const { promptForMeeting } = await import('./prompt.js');
  const { text } = await promptForMeeting(dir);
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
  return readMeeting(dir);
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
  const clean = (text ?? '').trim();
  if (!clean) throw new Error('Nothing to save.');
  await fsp.writeFile(path.join(dir, 'note.md'), clean + '\n');

  // The catch has to cover the parse too. Attached to the read alone, a transient
  // EBUSY yields '{}' and this write-back destroys the whole record while the UI
  // reports success.
  const metaPath = path.join(dir, 'meeting.json');
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
 * Deletion goes to the recycle bin, never a hard unlink. A meeting is a record of
 * a real conversation and the user may want it back.
 */
ipcMain.handle('delete-meeting', async (_evt, dir) => {
  await shell.trashItem(dir);
  await reindexSoon();
  return true;
});

/**
 * Open an assistant's web chat in the user's normal browser.
 *
 * This is the honest version of "log in to your AI account". Consumer
 * subscriptions expose no OAuth and no API to third-party apps, so the app never
 * touches credentials at all — it hands the browser a URL, where the user is
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
  // Only ever open a URL from this fixed table — never one built from user or
  // file content.
  if (!url) throw new Error(`Unknown provider: ${id}`);
  await shell.openExternal(url);
  return url;
});

ipcMain.handle('open-folder', async (_evt, dir) => {
  await shell.openPath(dir ?? MEETINGS_DIR);
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

/* --------------------------------------------------------------------- app */

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
