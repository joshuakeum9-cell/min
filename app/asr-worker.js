/**
 * ASR worker, one child process per audio track.
 *
 * This runs in its own process for a specific, measured reason: past ~398 s of
 * audio Parakeet raises an onnxruntime error inside self-attention that is a
 * NATIVE ABORT, not a catchable exception. A try/catch in-process does not save
 * you; the whole process dies. Isolating it means a bad chunk kills a worker the
 * parent can restart, not the app.
 *
 * The parent hands over a wav path and a speaker label. This process does the
 * voice-activity gating, the chunking and the recognition itself, and streams one
 * JSON line per utterance to stdout so the parent sees progress as it happens.
 *
 * Protocol (stdout, one JSON object per line):
 *   {"type":"ready","segments":N,"voicedSeconds":S}
 *   {"type":"segment","start":12.34,"end":18.90,"text":"..."}
 *   {"type":"done","segments":N,"ms":1234}
 *
 * Usage: node asr-worker.js <wav> <speaker> <modelDir> <vadModel> [threads]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const [wavPath, speaker, modelDir, vadModel, threadsArg] = process.argv.slice(2);
const THREADS = Math.max(1, parseInt(threadsArg ?? '4', 10));

/**
 * Chunk ceiling. The hard wall is 398 s; measured throughput also falls sharply
 * as chunks grow (≈15x realtime at 15 s, ≈5.6x at 360 s), so short chunks are both
 * safer and faster. 30 s is comfortably inside both.
 */
const MAX_CHUNK_SECONDS = 30;
const HARD_CEILING_SECONDS = 300;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

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

function main() {
  const m = findModelFiles(modelDir);

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
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

  // Electron forbids V8 external buffers, and sherpa hands them back by default.
  // Under `node` this only costs a copy; inside the packaged app, omitting it
  // fails outright with "External buffers are not allowed".
  const wave = sherpa.readWave(wavPath, false);
  const sampleRate = wave.sampleRate;

  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        minSilenceDuration: 0.35, // split at natural pauses, not mid-word
        minSpeechDuration: 0.25, // ignore lip smacks and keyboard clicks
        maxSpeechDuration: MAX_CHUNK_SECONDS,
      },
      sampleRate,
      numThreads: 1,
      debug: 0,
    },
    MAX_CHUNK_SECONDS * 2
  );

  // Collect speech segments first so the parent gets an honest total up front.
  const segments = [];
  const window = 512;
  for (let i = 0; i + window <= wave.samples.length; i += window) {
    vad.acceptWaveform(wave.samples.subarray(i, i + window));
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      segments.push({ start: seg.start, samples: seg.samples });
      vad.pop();
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    const seg = vad.front(false);
    segments.push({ start: seg.start, samples: seg.samples });
    vad.pop();
  }

  const voicedSamples = segments.reduce((a, s) => a + s.samples.length, 0);
  emit({
    type: 'ready',
    speaker,
    segments: segments.length,
    voicedSeconds: +(voicedSamples / sampleRate).toFixed(2),
    totalSeconds: +(wave.samples.length / sampleRate).toFixed(2),
  });

  const t0 = Date.now();
  let emitted = 0;

  for (const seg of segments) {
    // Belt and braces: VAD's maxSpeechDuration should already cap this, but a
    // chunk over the ceiling would abort the process, so split rather than trust.
    const cap = HARD_CEILING_SECONDS * sampleRate;
    for (let off = 0; off < seg.samples.length; off += cap) {
      const piece = seg.samples.subarray(off, Math.min(off + cap, seg.samples.length));
      const startSec = (seg.start + off) / sampleRate;

      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate, samples: piece });
      recognizer.decode(stream);
      const text = (recognizer.getResult(stream).text ?? '').trim();

      if (text) {
        // Energy travels with the utterance. When the same words land on both
        // tracks (speakers bleeding into the mic), the quieter copy is the echo.
        let sumSq = 0;
        for (let i = 0; i < piece.length; i++) sumSq += piece[i] * piece[i];

        emit({
          type: 'segment',
          speaker,
          start: +startSec.toFixed(2),
          end: +(startSec + piece.length / sampleRate).toFixed(2),
          rms: +Math.sqrt(sumSq / Math.max(1, piece.length)).toFixed(5),
          text,
        });
        emitted++;
      }
    }
  }

  emit({ type: 'done', speaker, segments: emitted, ms: Date.now() - t0 });
}

try {
  main();
  process.exit(0);
} catch (err) {
  emit({ type: 'error', speaker, error: String(err?.message ?? err) });
  process.exit(1);
}
