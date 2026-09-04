/**
 * granola-local · M2 — transcription.
 *
 * Takes a meeting folder produced by the recorder and turns the two audio tracks
 * into one interleaved transcript with speaker attribution.
 *
 * The attribution is free and exact. Because the microphone and the system
 * loopback were captured as separate tracks against one clock — and because
 * Chromium zero-fills the loopback through silence, so the two stay
 * sample-aligned — "who said this" is just "which file did it come from". No
 * diarization model, no clustering, no guessing.
 *
 * Both tracks are transcribed concurrently in separate processes. That is not
 * only for speed: a chunk over the recogniser's ~398 s ceiling aborts the process
 * outright, so isolation is what keeps one bad chunk from taking the app down.
 *
 * Usage:
 *   node app/transcribe.js                        # most recent meeting
 *   node app/transcribe.js ~/Meetings/<folder>
 *   node app/transcribe.js --all                  # every untranscribed meeting
 *   node app/transcribe.js <folder> --keep-audio  # do not delete the wavs
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureModel, parakeetPaths, llmPath } from '../m0/lib/models.js';
import { detectHardware, isMain } from '../m0/lib/hardware.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Inside a packaged app this file lives in app.asar, but the worker is spawned by
// real path, so it must point at the unpacked copy. Electron rewrites asar paths
// for fs calls automatically; it does not for spawn arguments.
const WORKER = path
  .join(HERE, 'asr-worker.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
export const MEETINGS_DIR = path.join(os.homedir(), 'Meetings');

const TRACKS = [
  { file: 'mic.wav', speaker: 'You' },
  { file: 'system.wav', speaker: 'Them' },
];

/* ------------------------------------------------------------------- worker */

const WORKER_STALL_MS = 10 * 60 * 1000;

function runWorker({ wav, speaker, modelDir, vadModel, threads, onProgress }) {
  return new Promise((resolve) => {
    // In a packaged app process.execPath is the Electron binary, not node, so a
    // bare spawn would launch a second copy of the app instead of the worker.
    // ELECTRON_RUN_AS_NODE makes that same binary behave as plain Node. Harmless
    // under `node`, which ignores it.
    const child = spawn(
      process.execPath,
      [WORKER, wav, speaker, modelDir, vadModel, String(threads)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    );

    const segments = [];
    let meta = null;
    let stderr = '';
    let workerError = null;
    let exitCode = null;
    let settled = false;
    let stall = null;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      resolve({
        speaker,
        segments,
        meta,
        ok: exitCode === 0 && !workerError,
        // A native abort is the case where the process died with NO in-band
        // error message. An error we were told about is a clean failure, however
        // fatal — conflating the two makes meeting.json untriageable.
        crashed: exitCode !== 0 && workerError === null,
        error: workerError,
        exitCode,
        stderr: stderr.slice(-500),
        ...extra,
      });
    };

    // A worker that spawns and then wedges (stalled onnxruntime, blocked model
    // read) never exits, so nothing above would ever fire.
    const bump = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        workerError = `no output for ${WORKER_STALL_MS / 60000} min — worker stalled`;
        child.kill();
        exitCode = exitCode ?? -1;
        finish();
      }, WORKER_STALL_MS);
      stall.unref?.();
    };
    bump();

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      bump();
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // native libraries print to stdout too; ignore non-JSON
      }
      if (msg.type === 'segment') {
        segments.push(msg);
        onProgress?.(speaker, segments.length, meta?.segments);
      } else if (msg.type === 'ready') {
        meta = msg;
        onProgress?.(speaker, 0, msg.segments);
      } else if (msg.type === 'done') {
        meta = { ...meta, ...msg };
      } else if (msg.type === 'error') {
        workerError = msg.error;
      }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); bump(); });

    child.on('error', (err) => {
      workerError = `spawn failed: ${err.message}`;
      exitCode = exitCode ?? -1;
      finish();
    });

    child.on('exit', (code) => { exitCode = code; });
    // 'close' fires after stdio drains, so a final `done` line is not lost.
    child.on('close', () => { exitCode = exitCode ?? -1; finish(); });
  });
}

/* ---------------------------------------------------------------- transcript */

const hhmmss = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/**
 * Acoustic bleed: on speakers rather than headphones, the microphone hears the
 * far end too, so the same words land on BOTH tracks. Chromium's echo
 * cancellation reduces this but does not remove it.
 *
 * The suppression is directional, and the direction is a physical fact rather
 * than a heuristic: the loopback track carries only what the OS is playing, which
 * can never contain the microphone. Bleed is therefore always system -> mic, and
 * the copy to drop is always the "You" one.
 */
const norm = (t) =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Fraction of a's words that also appear in b.
 *
 * Short utterances are refused outright. "No.", "Exactly", "Yeah" are trivially
 * contained in almost any longer sentence, and suppressing one deletes the user
 * disagreeing — turning a transcript of an argument into a record of consent.
 * A line that short carries no evidence either way, so it is never evidence of
 * an echo.
 */
const MIN_WORDS_FOR_BLEED = 5;

function containment(a, b) {
  const A = norm(a);
  if (A.length < MIN_WORDS_FOR_BLEED) return 0;
  const B = new Set(norm(b));
  const uniqueA = new Set(A);
  let hits = 0;
  // Count distinct words: "no, no, no, absolutely not" should not score 3/5 on
  // the strength of one repeated word.
  for (const w of uniqueA) if (B.has(w)) hits++;
  return hits / uniqueA.size;
}

const BLEED_SIMILARITY = 0.6;
const BLEED_SLOP_SECONDS = 0.3;

export function suppressBleed(segments, { similarity = BLEED_SIMILARITY } = {}) {
  const them = segments.filter((s) => s.speaker === 'Them');
  const suppressed = [];

  const kept = segments.filter((s) => {
    if (s.speaker !== 'You') return true;
    const dur = Math.max(0.01, s.end - s.start);

    const echoOf = them.find((t) => {
      // A real echo is the same sound arriving twice, so it must actually
      // overlap in time — not merely start nearby. Onset proximity alone lets a
      // reply land inside the window and be deleted as its own echo.
      const overlap = Math.min(s.end, t.end) - Math.max(s.start, t.start);
      if (overlap < dur * 0.8 - BLEED_SLOP_SECONDS) return false;

      // Symmetric: an echo resembles the original in BOTH directions. One-way
      // containment lets a short reply hide inside a long far-end turn.
      if (Math.min(containment(s.text, t.text), containment(t.text, s.text)) < similarity)
        return false;

      // The echo is the quieter copy. A louder mic means the user really was
      // talking over them, so keep it.
      return s.rms == null || t.rms == null || s.rms <= t.rms * 1.35;
    });

    if (echoOf) {
      suppressed.push({
        start: s.start, end: s.end, text: s.text, rms: s.rms ?? null,
        echoOfStart: echoOf.start,
      });
      return false;
    }
    return true;
  });

  return { kept, suppressed };
}

/**
 * Merge both tracks into one timeline. Overlapping speech is normal on a call, so
 * ordering by start time is the honest representation; the speaker label is what
 * keeps it readable.
 */
export function buildTranscript(results, opts = {}) {
  const all = results
    .flatMap((r) => r.segments)
    .sort((a, b) => a.start - b.start || (a.speaker === 'You' ? -1 : 1));

  const { kept, suppressed } = opts.noBleedSuppression
    ? { kept: all, suppressed: [] }
    : suppressBleed(all);

  const lines = [];
  let last = null;
  for (const s of kept) {
    // Fold consecutive utterances from one speaker into a paragraph.
    if (last && last.speaker === s.speaker && s.start - last.end < 2) {
      lines[lines.length - 1] += ' ' + s.text;
      last = { ...s, end: s.end };
      continue;
    }
    lines.push('[' + hhmmss(s.start) + '] ' + s.speaker + ': ' + s.text);
    last = s;
  }
  const body = lines.join(String.fromCharCode(10));
  return {
    text: body + (lines.length ? String.fromCharCode(10) : ''),
    count: kept.length,
    suppressed,
  };
}

/* ------------------------------------------------------------------ meeting */

async function findMeetings(explicit, all) {
  if (explicit) return [path.resolve(explicit)];
  const entries = await fsp.readdir(MEETINGS_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(MEETINGS_DIR, e.name)).sort();
  if (!dirs.length) return [];
  if (!all) return [dirs[dirs.length - 1]];

  const pending = [];
  for (const d of dirs) {
    const done = await fsp.stat(path.join(d, 'transcript.md')).then(() => true).catch(() => false);
    if (!done) pending.push(d);
  }
  return pending;
}

export async function transcribeMeeting(dir, opts = {}) {
  const { keepAudio = false, threads = 4, asrModel = 'parakeet-v3', quiet = false } = opts;
  const log = (s) => !quiet && console.log(s);

  const modelDir = await ensureModel(asrModel);
  const vadModel = llmPath('silero-vad');
  await ensureModel('silero-vad');

  const present = [];
  for (const t of TRACKS) {
    const p = path.join(dir, t.file);
    if (await fsp.stat(p).then((s) => s.size > 44).catch(() => false)) present.push({ ...t, wav: p });
  }
  if (!present.length) {
    throw new Error(`No audio in ${dir}. Already transcribed, or the recording failed.`);
  }

  log(`\n▸ ${path.basename(dir)}`);
  const t0 = Date.now();

  // Both tracks at once. Halve the threads each so they do not fight for cores.
  const per = Math.max(1, Math.floor(threads / present.length));
  const results = await Promise.all(
    present.map((t) =>
      runWorker({
        wav: t.wav,
        speaker: t.speaker,
        modelDir,
        vadModel,
        threads: per,
        onProgress: (speaker, done, total) => {
          if (!quiet && total) process.stdout.write(`\r   ${speaker}: ${done}/${total} utterances   `);
        },
      })
    )
  );
  if (!quiet) process.stdout.write('\r' + ' '.repeat(50) + '\r');

  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    log(
      `   ⚠ ${f.speaker} worker ${f.crashed ? 'ABORTED (native crash)' : 'failed'} ` +
        `exit=${f.exitCode}${f.signal ? ` signal=${f.signal}` : ''}`
    );
    if (f.stderr) log(`     ${f.stderr.split('\n')[0]}`);
  }

  for (const r of results) {
    if (r.meta) {
      log(
        `   ${r.speaker.padEnd(5)} ${String(r.meta.segments ?? 0).padStart(3)} utterances · ` +
          `${r.meta.voicedSeconds}s voiced of ${r.meta.totalSeconds}s · ${((r.meta.ms ?? 0) / 1000).toFixed(1)}s`
      );
    }
  }

  // Decide success BEFORE writing anything. A partial transcript written to the
  // canonical name marks the meeting done forever: library.js treats any
  // transcript.md as finished, the GUI stops offering to retry, and --all skips
  // the folder — while the other speaker's half is simply missing.
  const allOk = results.every((r) => r.ok);

  const { text, count, suppressed } = buildTranscript(results, {
    noBleedSuppression: opts.noBleedSuppression,
  });

  if (!allOk && !count) {
    throw new Error(
      `Both workers failed and produced nothing. Audio kept. ` +
        results.filter((r) => !r.ok).map((r) => `${r.speaker}: ${r.error ?? 'crashed'}`).join('; ')
    );
  }
  if (suppressed.length) {
    log(`   ${suppressed.length} echo line(s) suppressed - you were on speakers, not headphones`);
  }
  const transcriptName = allOk ? 'transcript.md' : 'transcript.partial.md';
  await fsp.writeFile(path.join(dir, transcriptName), text);

  // Update the meeting record before deleting anything.
  const metaPath = path.join(dir, 'meeting.json');
  // The catch must cover the parse as well as the read. Attached to readFile
  // alone, a transient EBUSY (AV scanner, sync client) yields '{}' and the
  // write-back below silently destroys title, timings and track integrity.
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Could not read meeting.json (${err.message}). Refusing to overwrite it.`);
    }
    meta = {};
  }
  const wallMs = Date.now() - t0;
  const audioSeconds = meta.durationSeconds ?? 0;

  meta.transcript = {
    at: new Date().toISOString(),
    engine: 'sherpa-onnx',
    model: asrModel,
    utterances: count,
    // Keep the suppressed lines themselves, not just a tally. They cost a couple
    // of hundred bytes, and without them a wrong suppression is unrecoverable
    // once the audio is deleted a few lines below.
    echoesSuppressed: { count: suppressed.length, segments: suppressed },
    wallSeconds: +(wallMs / 1000).toFixed(1),
    realtimeFactor: audioSeconds ? +(audioSeconds / (wallMs / 1000)).toFixed(2) : null,
    complete: allOk,
    perTrack: results.map((r) => ({
      speaker: r.speaker,
      ok: r.ok,
      crashed: r.crashed,
      error: r.error ?? null,
      utterances: r.segments.length,
      voicedSeconds: r.meta?.voicedSeconds ?? null,
    })),
  };

  // Only discard audio when BOTH tracks succeeded. A crashed worker means the
  // transcript is incomplete, and the audio is the only way to try again.
  if (allOk && !keepAudio) {
    for (const t of present) await fsp.rm(t.wav, { force: true });
    meta.audioDisposition = 'deleted after successful transcription';
    log(`   audio deleted (${present.length} files)`);
  } else {
    meta.audioDisposition = keepAudio
      ? 'kept — --keep-audio'
      : 'kept — a worker failed, so the transcript may be incomplete';
    log(`   audio KEPT — ${allOk ? '--keep-audio' : 'a worker failed'}`);
  }

  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');

  const rtf = meta.transcript.realtimeFactor;
  log(
    `   → ${transcriptName} · ${count} utterances · ${(wallMs / 1000).toFixed(1)}s` +
      (rtf ? ` (${rtf}x realtime)` : '')
  );
  return { dir, count, meta, ok: allOk };
}

/* --------------------------------------------------------------------- main */

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const target = argv.find((a) => !a.startsWith('--'));
  const hw = detectHardware();
  const threads = Math.max(2, Math.min(6, hw.physicalCores));

  const dirs = await findMeetings(target, flags.has('--all'));
  if (!dirs.length) {
    console.log(`No meetings found in ${MEETINGS_DIR}. Record one first.`);
    process.exit(0);
  }

  console.log(
    `Transcribing ${dirs.length} meeting(s) with ${threads} threads, CPU only.` +
      `\nSpeaker labels come from which track the audio was on — no diarization needed.`
  );

  let failures = 0;
  for (const dir of dirs) {
    try {
      const r = await transcribeMeeting(dir, {
        keepAudio: flags.has('--keep-audio'),
        threads,
        asrModel: flags.has('--v2') ? 'parakeet-v2' : 'parakeet-v3',
        noBleedSuppression: flags.has('--no-bleed-suppression'),
      });
      if (!r.ok) failures++;
    } catch (err) {
      console.log(`\n   ✗ ${path.basename(dir)}: ${err.message}`);
      failures++;
    }
  }
  console.log();
  process.exit(failures ? 1 : 0);
}
