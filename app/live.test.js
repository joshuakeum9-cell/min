/**
 * Live transcription harness.
 *
 * Streams two wavs into createLiveSession the way the renderer will, 250 ms of
 * each track per tick on a real-time clock, and reports the number that decides
 * whether near-live is real: how far behind the conversation the text arrives.
 *
 *   node app/live.test.js <you.wav> <them.wav>    real-time pacing, 16 kHz mono
 *   node app/live.test.js                         synthesised conversation
 *   node app/live.test.js --fast                  no pacing, for CI
 *   node app/live.test.js --solo                  the you track only
 *   node app/live.test.js --threads 4 --verbose   worker stderr too
 *
 * With no wavs it builds a 30 s conversation from the speech model's own test
 * clips, with the far end mixed quietly into the microphone track the way
 * speakers bleed into a mic, so the echo path runs as well. If even those
 * clips are missing it falls back to tone bursts, which prove only that the
 * pipeline runs end to end, and it says so.
 *
 * Lag is measured per segment from the moment the frame holding its last
 * sample was pushed to the moment its text came back. That is what the user
 * experiences as "how late is this". The first-word figure is the same clock
 * from the segment's first sample, and is dominated by utterance length.
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ensureModel, llmPath } from '../m0/lib/models.js';
import { createLiveSession, toTranscriptResults } from './live.js';
import { buildTranscript } from './transcribe.js';

const SR = 16000;
const FRAME = SR / 4; // 250 ms, the cadence the renderer will use
const FRAME_MS = 250;

/* -------------------------------------------------------------------- wav */

function resample(f32, from, to) {
  const n = Math.floor((f32.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * r;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = f32[j] * (1 - f) + (f32[Math.min(j + 1, f32.length - 1)] ?? 0) * f;
  }
  return out;
}

/** 16-bit PCM RIFF to Float32 mono at 16 kHz. Stereo is averaged, other rates resampled. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file}: no fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`${file}: only 16-bit PCM is supported (format ${fmt.format}, ${fmt.bits} bits)`);
  }
  const frames = Math.floor(data.length / (2 * fmt.channels));
  let mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels / 32768;
  }
  if (fmt.sampleRate !== SR) mono = resample(mono, fmt.sampleRate, SR);
  return mono;
}

const toInt16 = (f32) => {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767);
  return out;
};

/* -------------------------------------------------------------- synthetic */

/** Add src into dst at a time offset, scaled. Additive so bleed can sit under real speech. */
function place(dst, src, atSeconds, gain = 1) {
  const at = Math.round(atSeconds * SR);
  for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i] += src[i] * gain;
}

function toneBurst(seconds, hz = 440) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/**
 * A 30 s two-sided conversation with a leading silence, a gap, one turn where
 * the far end bleeds into the mic at -14 dB (should be flagged echo), and one
 * genuine cross-talk turn (must be kept).
 */
function synthesise(modelDir) {
  const clips = [
    path.join(modelDir, 'test_wavs', 'en.wav'),
    path.join(modelDir, '..', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'test_wavs', '0.wav'),
  ].filter((f) => fs.existsSync(f));

  const you = new Float32Array(30 * SR);
  const them = new Float32Array(30 * SR);
  let note;

  if (clips.length) {
    const a = readWav(clips[0]);
    const b = clips[1] ? readWav(clips[1]) : a;
    place(you, a, 1.0); // you open
    place(them, b, 5.5); // they answer at length
    place(you, b, 5.54, 0.2); // and the mic hears it, 40 ms late, 14 dB down
    place(you, a, 14.0); // you again
    place(them, b, 18.5); // they talk
    place(you, a, 21.0); // you cut in over them: real speech, must survive
    note =
      `synthetic conversation from ${clips.map((f) => path.basename(f)).join(' and ')}, ` +
      `with simulated speaker bleed at 5.5s and real cross-talk at 21s`;
  } else {
    place(you, toneBurst(2), 1);
    place(them, toneBurst(3, 660), 5);
    place(you, toneBurst(2), 10);
    note = 'TONE BURSTS ONLY: the model test clips are missing, so this proves the pipeline runs, not that it transcribes';
  }
  return { you, them, note };
}

/* ------------------------------------------------------------------- main */

function parseArgs(argv) {
  const a = { wavs: [], fast: false, solo: false, verbose: false, threads: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fast') a.fast = true;
    else if (k === '--solo') a.solo = true;
    else if (k === '--verbose') a.verbose = true;
    else if (k === '--threads') a.threads = parseInt(argv[++i], 10) || 4;
    else if (k.startsWith('--')) throw new Error(`unknown flag ${k}`);
    else a.wavs.push(k);
  }
  if (a.wavs.length === 1) throw new Error('give both wavs (you.wav them.wav) or neither');
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const secs = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The session resolves models itself; resolving here too costs nothing (the
  // check is size-only once downloaded) and gives the synthesiser the clip dir.
  const modelDir = await ensureModel('parakeet-v3');
  await ensureModel('silero-vad');

  let you, them, note;
  if (args.wavs.length) {
    you = readWav(args.wavs[0]);
    them = readWav(args.wavs[1]);
    note = `${path.basename(args.wavs[0])} (${(you.length / SR).toFixed(1)}s) and ${path.basename(args.wavs[1])} (${(them.length / SR).toFixed(1)}s)`;
  } else {
    ({ you, them, note } = synthesise(modelDir));
  }
  const tracks = { you: toInt16(you), them: toInt16(them) };
  const active = args.solo ? ['you'] : ['you', 'them'];
  const length = Math.max(...active.map((t) => tracks[t].length));
  const nFrames = Math.ceil(length / FRAME);

  console.log(`Audio: ${note}`);
  console.log(
    `Mode:  ${args.fast ? 'fast (no pacing; lag here is decode backlog, not live latency)' : 'real time'}` +
      `${args.solo ? ', you track only' : ''}, ${args.threads} threads, ${nFrames} frames of ${FRAME_MS} ms per track\n`
  );

  const pushedAt = { you: [], them: [] };
  const frameOf = (seconds) => Math.min(nFrames - 1, Math.floor((seconds * SR) / FRAME));
  const lags = [];
  const firstWordLags = [];
  let echoAmendments = 0;
  const t0 = performance.now();
  const clock = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`;

  const session = createLiveSession({
    modelDir,
    vadModel: llmPath('silero-vad'),
    threads: args.threads,
    onProgress: (p) => {
      if (p.phase === 'download') {
        console.log(`${clock()}  downloading ${p.model}: ${((p.received / p.total) * 100).toFixed(0)}%`);
      } else console.log(`${clock()}  loading models`);
    },
    onReady: ({ ms, restart }) => console.log(`${clock()}  ready, models loaded in ${ms} ms${restart ? ` (restart ${restart})` : ''}\n`),
    onSegment: (s) => {
      const now = performance.now();
      const lag = now - pushedAt[s.track][frameOf(s.t1)];
      const first = now - pushedAt[s.track][frameOf(s.t0)];
      lags.push(lag);
      firstWordLags.push(first);
      console.log(
        `${clock()}  ${s.track.padEnd(4)} ${s.t0.toFixed(1).padStart(5)}-${s.t1.toFixed(1).padEnd(5)}  ` +
          `lag ${secs(lag)}  first word ${secs(first)}  ${s.echo ? `[ECHO of them@${s.echoOf}] ` : ''}"${s.text}"`
      );
    },
    onEcho: (s) => {
      echoAmendments++;
      console.log(`${clock()}  ~ you ${s.t0}-${s.t1} amended: echo of them@${s.echoOf}`);
    },
    onError: (e) => console.log(`${clock()}  ${e.recoverable ? 'warning' : 'ERROR'}: ${e.message}`),
    onLog: args.verbose ? (l) => console.log(`         worker: ${l}`) : undefined,
  });

  const streamStart = performance.now();
  for (let i = 0; i < nFrames; i++) {
    if (!args.fast) {
      const wait = streamStart + i * FRAME_MS - performance.now();
      if (wait > 0) await sleep(wait);
    }
    for (const track of active) {
      const s = i * FRAME;
      // Pad the shorter track with silence so both clocks run to the same end,
      // as the renderer's zero-filled loopback does.
      let slice = tracks[track].subarray(s, Math.min(s + FRAME, tracks[track].length));
      if (slice.length < FRAME) {
        const padded = new Int16Array(FRAME);
        padded.set(slice);
        slice = padded;
      }
      pushedAt[track][i] = performance.now();
      await session.push(track, slice);
    }
  }
  const pushed = performance.now();
  console.log(`\n${clock()}  all audio pushed (${(length / SR).toFixed(1)}s), stopping`);

  const result = await session.stop();
  const stopMs = performance.now() - pushed;

  const kept = result.segments.filter((s) => !s.echo);
  const echoes = result.segments.length - kept.length;
  console.log(`${clock()}  stop() resolved in ${secs(stopMs)}\n`);
  console.log('Summary');
  console.log(`  segments      ${result.segments.length} (${kept.length} kept, ${echoes} flagged echo, ${echoAmendments} amended after display)`);
  console.log(`  lag           median ${secs(quantile(lags, 0.5))}  p95 ${secs(quantile(lags, 0.95))}  max ${secs(quantile(lags, 1))}`);
  console.log(`  first word    median ${secs(quantile(firstWordLags, 0.5))}  p95 ${secs(quantile(firstWordLags, 0.95))}`);
  console.log(`  worker        ok=${result.ok} complete=${result.complete} restarts=${result.restarts}${result.error ? ` error="${result.error}"` : ''}`);

  const transcript = buildTranscript(toTranscriptResults(result.segments));
  console.log(`\nTranscript (${transcript.count} lines, as transcript.md would be written):\n`);
  process.stdout.write(transcript.text.replace(/^/gm, '  '));

  const toneOnly = note.startsWith('TONE');
  const failed = !result.ok || (!toneOnly && result.segments.length === 0);
  if (failed) console.log('\nFAILED: ' + (result.error ?? 'no segments came back from speech'));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
