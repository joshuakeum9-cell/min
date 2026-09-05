/**
 * Live ASR worker: one long-lived child process for both audio tracks.
 *
 * The one-shot worker (asr-worker.js) is handed a finished wav. This one is
 * handed the recording while it is still happening: the parent streams raw PCM
 * frames down stdin, this process runs voice-activity detection on each track,
 * and it transcribes an utterance the moment the speaker pauses. That is what
 * puts the conversation on screen a few seconds behind real time instead of
 * five minutes after the call ends, and it is why the segments it emits ARE the
 * transcript: nothing is re-run over the audio afterwards.
 *
 * One process for both tracks, not one per track as in the batch path, because
 * Parakeet is a 650 MB model and the target machine has 8 GB. Loading it once
 * and decoding both tracks through it costs nothing visible at 10x realtime and
 * halves the memory.
 *
 * Still a child process, for the same reason as the batch worker: past ~398 s of
 * audio Parakeet dies with a native abort that no try/catch survives. The caps
 * below keep utterances two orders of magnitude under that, and the parent can
 * respawn this process if it dies anyway.
 *
 * stdin, binary frames, so PCM never goes through JSON:
 *   u8 track (0 = you, 1 = them), u32le sample count N, then N int16le samples
 *   at 16 kHz mono. N = 0 is the flush for that track: the recording has stopped.
 *
 * stdout, one JSON object per line and nothing else (logs go to stderr):
 *   {"type":"progress","phase":"loading"}                    model load started
 *   {"type":"ready","ms":N}                                   models resident
 *   {"type":"segment","track":"you"|"them","t0":S,"t1":S,"text":"...","rms":R,
 *    "echo":false}                                            one utterance
 *   {"type":"echo","track":"you","t0":S,"t1":S,"echoOf":S}    a segment already
 *        emitted has since been shown to be the far end leaking into the mic
 *   {"type":"done","segments":N,"echoes":N}                   after both flushes
 *   {"type":"error","message":"..."}
 *
 * t0/t1 are seconds from the start of the recording. Both tracks start on the
 * same instant and stay sample-aligned (measured, see CLAUDE.md), so the sample
 * count is the clock and no wall-clock timestamps travel with the audio.
 *
 * Usage: node asr-live-worker.js <modelDir> <vadModel> [threads] [youOffset] [themOffset]
 * The offsets are sample counts a previous worker already consumed, so a respawn
 * after a crash continues the clock instead of restarting it at zero.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const [modelDir, vadModel, threadsArg, youOffsetArg, themOffsetArg] = process.argv.slice(2);
const THREADS = Math.max(1, parseInt(threadsArg ?? '4', 10));

const SR = 16000;
const WINDOW = 512; // Silero's frame at 16 kHz
const YOU = 0;
const THEM = 1;

/**
 * Utterance length. Nothing from an utterance is shown until it closes, so the
 * cap is the worst-case lag, not just a safety margin.
 *
 * The soft cap is the VAD's own: once a turn passes it, the detector splits at
 * the next tiny pause rather than the next real one. Measured here that lands
 * 1.5 to 3.5 s later. The hard cap is ours, for a speaker who never pauses at
 * all: the open segment is cut there regardless of what the detector thinks.
 */
const SOFT_CAP_SECONDS = 10;
const HARD_CAP_SECONDS = 20;

// Where the VAD places a segment's start relative to the window that tripped
// it: two windows plus the minimum speech duration, from upstream's
// voice-activity-detector.cc. Only used to time the hard cap and the bleed hold.
const PREROLL_SAMPLES = 2 * WINDOW + Math.round(0.25 * SR);

// A frame this large is not audio, it is a corrupt header. A minute at 16 kHz.
const MAX_FRAME_SAMPLES = 60 * SR;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (s) => process.stderr.write(`[asr-live] ${s}\n`);

function findModelFiles(dir) {
  const files = fs.readdirSync(dir);
  const pick = (re) => {
    const f = files.find((x) => re.test(x));
    if (!f) throw new Error(`no file matching ${re} in ${dir}`);
    return path.join(dir, f);
  };
  return {
    encoder: pick(/^encoder.*\.onnx$/),
    decoder: pick(/^decoder.*\.onnx$/),
    joiner: pick(/^joiner.*\.onnx$/),
    tokens: pick(/^tokens\.txt$/),
  };
}

/* ------------------------------------------------------------------ tracks */

const tracks = ['you', 'them'].map((name, id) => {
  const base = Math.max(0, parseInt([youOffsetArg, themOffsetArg][id] ?? '0', 10) || 0);
  return {
    id,
    name,
    vad: null,
    // Frames are 250 ms and the VAD wants 512-sample windows, so a partial
    // window carries over between frames.
    window: new Float32Array(WINDOW),
    fill: 0,
    base,
    clock: base, // samples fed so far, including a previous worker's share
    inSpeech: false,
    speechStart: 0,
    flushed: false,
    recent: [], // decoded segments from the last couple of minutes, for the bleed check
  };
});

let recognizer = null;
let emitted = 0;
let echoes = 0;
let finished = false;

/* ------------------------------------------------------------------- bleed */

/**
 * Acoustic bleed, ported from transcribe.js. On speakers rather than headphones
 * the microphone hears the far end too, so the same words land on BOTH tracks.
 * The loopback track can never contain the microphone, so the copy that is the
 * echo is always the "you" one.
 *
 * This is the one place the pipeline hides text, so it is deliberately harder
 * to trigger than to miss: the two intervals must genuinely overlap, the
 * candidate needs five distinct words (a bare "No." is contained in almost any
 * sentence, and suppressing it turns a disagreement into consent), the match
 * must hold in both directions, and the mic copy must be the quieter one. Even
 * then the segment is emitted, flagged, never dropped: the parent keeps it and
 * the transcript writer decides.
 */
const MIN_WORDS_FOR_BLEED = 5;
const BLEED_SIMILARITY = 0.6;
const BLEED_SLOP_SECONDS = 0.3;
const BLEED_RMS_RATIO = 1.35;

const norm = (t) =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Fraction of a's distinct words that also appear in b. */
function containment(a, b) {
  const A = norm(a);
  if (A.length < MIN_WORDS_FOR_BLEED) return 0;
  const B = new Set(norm(b));
  const uniqueA = new Set(A);
  let hits = 0;
  for (const w of uniqueA) if (B.has(w)) hits++;
  return hits / uniqueA.size;
}

function isEchoOf(you, them) {
  const overlap = Math.min(you.t1, them.t1) - Math.max(you.t0, them.t0);
  if (overlap <= 0) return false;
  const dur = Math.max(0.01, you.t1 - you.t0);
  if (overlap < dur * 0.8 - BLEED_SLOP_SECONDS) return false;
  if (Math.min(containment(you.text, them.text), containment(them.text, you.text)) < BLEED_SIMILARITY) {
    return false;
  }
  return you.rms <= them.rms * BLEED_RMS_RATIO;
}

/**
 * The echo and its original close at the same silence, so they are decoded
 * within a second or two of each other, but in no fixed order. A "you" segment
 * is therefore held, briefly, until the far-end track has been heard past its
 * end and has no utterance still open across it. Then it is judged and emitted.
 *
 * The hold is bounded: if the far end talks straight through (the user
 * interjecting over a monologue, the normal cross-talk case), the line goes out
 * unjudged after HOLD_MAX_MS rather than waiting up to a whole capped
 * utterance. Should the far-end text later prove it an echo, an "echo" line
 * amends it. Latency for the user's own words is never traded for tidiness.
 */
const HOLD_SLOP_SECONDS = 0.5;
const HOLD_MAX_MS = 3000;
const RECENT_SECONDS = 120;

const held = [];
let holdTimer = null;

function judge(seg) {
  const orig = tracks[THEM].recent.find((o) => isEchoOf(seg, o));
  if (orig) {
    seg.echo = true;
    seg.echoOf = orig.t0;
    echoes++;
  }
}

function release(seg) {
  judge(seg);
  emit(seg);
  emitted++;
}

function releaseHeld(force = false) {
  const them = tracks[THEM];
  // A far-end track that has never delivered a frame has nothing to compare
  // against, and a caller feeding one track would otherwise pay the full
  // deadline on every line.
  const nothingToCompare = them.clock === them.base;
  while (held.length) {
    const { seg, deadline } = held[0];
    const heardPast = nothingToCompare || them.clock / SR >= seg.t1 + HOLD_SLOP_SECONDS;
    const stillOpen = them.inSpeech && them.speechStart / SR < seg.t1;
    if (!force && !(heardPast && !stillOpen) && Date.now() < deadline) break;
    held.shift();
    release(seg);
  }
  if (!held.length && holdTimer) {
    clearInterval(holdTimer);
    holdTimer = null;
  }
}

function hold(seg) {
  held.push({ seg, deadline: Date.now() + HOLD_MAX_MS });
  releaseHeld();
  // The deadline must fire even when no more audio arrives on either track.
  if (held.length && !holdTimer) holdTimer = setInterval(releaseHeld, 250);
}

/** A far-end segment just landed: any "you" line already on screen that it explains gets amended. */
function amendEmitted(themSeg) {
  for (const y of tracks[YOU].recent) {
    if (y.echo || held.some((h) => h.seg === y)) continue;
    if (!isEchoOf(y, themSeg)) continue;
    y.echo = true;
    y.echoOf = themSeg.t0;
    echoes++;
    emit({ type: 'echo', track: 'you', t0: y.t0, t1: y.t1, echoOf: themSeg.t0 });
  }
}

function forget(t) {
  const horizon = t.clock / SR - RECENT_SECONDS;
  while (t.recent.length && t.recent[0].t1 < horizon) t.recent.shift();
}

/* -------------------------------------------------------------- recognise */

function transcribe(t, startSample, samples) {
  // The VAD already enforces the cap, but the abort past 398 s is fatal to the
  // process, so no single layer is trusted with it.
  const cap = HARD_CAP_SECONDS * SR;
  for (let off = 0; off < samples.length; off += cap) {
    const piece = samples.subarray(off, Math.min(off + cap, samples.length));
    const t0 = (t.base + startSample + off) / SR;
    const t1 = t0 + piece.length / SR;

    const began = Date.now();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SR, samples: piece });
    recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text ?? '').trim();
    log(
      `${t.name.padEnd(4)} ${t0.toFixed(2)}-${t1.toFixed(2)} ` +
        `${(piece.length / SR).toFixed(1)}s audio in ${Date.now() - began} ms` +
        (text ? '' : ', no text')
    );
    if (!text) continue;

    // Energy travels with the utterance: when the same words land on both
    // tracks, the quieter copy is the echo.
    let sumSq = 0;
    for (let i = 0; i < piece.length; i++) sumSq += piece[i] * piece[i];

    const seg = {
      type: 'segment',
      track: t.name,
      t0: +t0.toFixed(2),
      t1: +t1.toFixed(2),
      text,
      rms: +Math.sqrt(sumSq / piece.length).toFixed(5),
      echo: false,
    };
    t.recent.push(seg);
    forget(t);

    if (t.id === THEM) {
      emit(seg);
      emitted++;
      amendEmitted(seg);
      releaseHeld();
    } else {
      hold(seg);
    }
  }
}

function drain(t) {
  while (!t.vad.isEmpty()) {
    // false: no V8 external buffers. Electron forbids them, and the packaged
    // app fails outright without this.
    const seg = t.vad.front(false);
    t.vad.pop();
    transcribe(t, seg.start, seg.samples);
  }
}

function afterWindow(t) {
  const speaking = t.vad.isDetected();
  if (speaking && !t.inSpeech) t.speechStart = t.clock - PREROLL_SAMPLES;
  if (speaking && t.clock - t.speechStart >= HARD_CAP_SECONDS * SR) {
    // Pops the open segment. The detector keeps running and opens the next one
    // exactly where this one ended, verified against this sherpa build.
    t.vad.flush();
  }
  t.inSpeech = t.vad.isDetected();
  drain(t);
  if (t.id === THEM) releaseHeld();
}

/** Int16 bytes straight from the frame into the VAD, one window at a time. */
function feed(t, buf, off, n) {
  for (let i = 0; i < n; i++, off += 2) {
    // Read by hand: the payload starts at byte 5 of the frame, and an
    // Int16Array view needs an even offset.
    let v = buf[off] | (buf[off + 1] << 8);
    if (v & 0x8000) v -= 0x10000;
    t.window[t.fill++] = v / 32768;
    if (t.fill === WINDOW) {
      t.vad.acceptWaveform(t.window);
      t.fill = 0;
      t.clock += WINDOW;
      afterWindow(t);
    }
  }
}

function flushTrack(t) {
  if (t.flushed) return;
  t.flushed = true;
  // A partial window is real audio. Pad it out rather than drop the last syllable.
  if (t.fill) {
    t.window.fill(0, t.fill);
    t.vad.acceptWaveform(t.window);
    t.clock += t.fill;
    t.fill = 0;
  }
  t.vad.flush();
  drain(t);
  if (tracks.every((x) => x.flushed)) finish();
}

function finish() {
  if (finished) return;
  finished = true;
  releaseHeld(true);
  if (holdTimer) clearInterval(holdTimer);
  process.stdin.destroy();
  // Exit from the write callback, not straight after the write: stdout is a
  // pipe, and pipe writes are asynchronous on Windows, so process.exit() here
  // could drop the final line the parent is waiting for.
  process.stdout.write(JSON.stringify({ type: 'done', segments: emitted, echoes }) + '\n', () =>
    process.exit(0)
  );
  setTimeout(() => process.exit(0), 5000).unref();
}

function fail(err) {
  if (finished) return;
  finished = true;
  process.stdin.destroy();
  process.stdout.write(
    JSON.stringify({ type: 'error', message: String(err?.message ?? err) }) + '\n',
    () => process.exit(1)
  );
  setTimeout(() => process.exit(1), 5000).unref();
}

/* ------------------------------------------------------------------- stdin */

let pending = Buffer.alloc(0);

function onData(chunk) {
  try {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    while (!finished && pending.length - off >= 5) {
      const id = pending[off];
      const n = pending.readUInt32LE(off + 1);
      if (id > THEM || n > MAX_FRAME_SAMPLES) {
        throw new Error(`bad frame header: track ${id}, ${n} samples`);
      }
      const need = 5 + n * 2;
      if (pending.length - off < need) break;
      const t = tracks[id];
      if (n === 0) flushTrack(t);
      else if (!t.flushed) feed(t, pending, off + 5, n);
      off += need;
    }
    pending = off ? pending.subarray(off) : pending;
  } catch (err) {
    fail(err);
  }
}

/* -------------------------------------------------------------------- main */

function main() {
  emit({ type: 'progress', phase: 'loading' });
  const began = Date.now();
  const m = findModelFiles(modelDir);

  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner },
      tokens: m.tokens,
      numThreads: THREADS,
      provider: 'cpu', // never assume a GPU; the target machine has none
      debug: 0,
      modelType: 'nemo_transducer',
    },
    decodingMethod: 'greedy_search',
  });

  for (const t of tracks) {
    t.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: vadModel,
          threshold: 0.5,
          minSilenceDuration: 0.35, // split at natural pauses, not mid-word
          minSpeechDuration: 0.25, // ignore lip smacks and keyboard clicks
          maxSpeechDuration: SOFT_CAP_SECONDS,
        },
        sampleRate: SR,
        numThreads: 1,
        debug: 0,
      },
      HARD_CAP_SECONDS * 2
    );
  }

  log(
    `models loaded in ${Date.now() - began} ms, ${THREADS} threads, ` +
      `clock you=${(tracks[YOU].base / SR).toFixed(1)}s them=${(tracks[THEM].base / SR).toFixed(1)}s`
  );
  emit({ type: 'ready', ms: Date.now() - began });

  process.stdin.on('data', onData);
  // The parent closing the pipe without flush frames means it died or gave up:
  // finish what is buffered and leave, rather than sit here holding the model.
  process.stdin.on('end', () => { for (const t of tracks) flushTrack(t); });
  process.stdin.on('error', () => { for (const t of tracks) flushTrack(t); });
  process.stdout.on('error', () => process.exit(0)); // nobody left to report to
}

try {
  main();
} catch (err) {
  fail(err);
}
