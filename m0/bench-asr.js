/**
 * M0 · ASR throughput benchmark.
 *
 * Answers: how long does a 60-minute meeting take to transcribe on the CPU,
 * and how much memory does it hold while doing it?
 *
 * The research claims ~7x realtime on a no-GPU laptop, i.e. ~9 minutes for an
 * hour of audio. That number was an extrapolation from 2025-era benchmarks on
 * different hardware. This measures it.
 *
 * Usage:
 *   node m0/bench-asr.js                          # bundled test clip, v2, auto threads
 *   node m0/bench-asr.js --model parakeet-v3
 *   node m0/bench-asr.js --wav path/to/meeting.wav --threads 4
 *   node m0/bench-asr.js --compare                # v2 vs v3 on the same audio
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectHardware, describe, validateTestBed, isMain } from './lib/hardware.js';
import { ensureModel, parakeetPaths } from './lib/models.js';
import { saveResult } from './lib/report.js';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const a = { model: 'parakeet-v2', wav: null, threads: 0, compare: false, runs: 1, synth: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--model') a.model = argv[++i];
    else if (k === '--wav') a.wav = argv[++i];
    else if (k === '--threads') a.threads = parseInt(argv[++i], 10);
    else if (k === '--runs') a.runs = parseInt(argv[++i], 10);
    else if (k === '--synth') a.synth = parseFloat(argv[++i]);
    else if (k === '--compare') a.compare = true;
  }
  return a;
}

/**
 * Build a long test clip by tiling a short one.
 *
 * A 7-second clip cannot tell you whether throughput holds for an hour, and it
 * says nothing about peak memory at scale — which is the question that decides
 * whether an 8 GB machine can hold the ASR and language models at once.
 * This is a THROUGHPUT and MEMORY probe only; repeated speech says nothing
 * about accuracy.
 */
async function synthesizeLongWav(sherpa, sourceWav, minutes, outPath) {
  const src = sherpa.readWave(sourceWav);
  const wantSamples = Math.round(minutes * 60 * src.sampleRate);
  const tiles = Math.ceil(wantSamples / src.samples.length);
  const buf = new Float32Array(wantSamples);
  for (let i = 0; i < tiles; i++) {
    const at = i * src.samples.length;
    const take = Math.min(src.samples.length, wantSamples - at);
    if (take <= 0) break;
    buf.set(src.samples.subarray(0, take), at);
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  sherpa.writeWave(outPath, { samples: buf, sampleRate: src.sampleRate });
  return outPath;
}

/** Peak RSS sampler. Node gives no built-in high-water mark. */
function watchMemory(intervalMs = 100) {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, intervalMs);
  t.unref();
  return {
    stop() {
      clearInterval(t);
      return peak;
    },
  };
}

const MiB = 1024 ** 2;
const mib = (n) => +(n / MiB).toFixed(0);

async function pickWav(modelDir, explicit) {
  if (explicit) return path.resolve(explicit);
  const dir = path.join(modelDir, 'test_wavs');
  const files = await fsp.readdir(dir).catch(() => []);
  const en = files.find((f) => /^(en|0)\.wav$/.test(f)) ?? files.find((f) => f.endsWith('.wav'));
  if (!en) throw new Error(`No test wav found in ${dir}. Pass --wav explicitly.`);
  return path.join(dir, en);
}

export async function benchModel({ model, wav, threads, runs, sherpa }) {
  const dir = await ensureModel(model);
  const p = await parakeetPaths(dir);
  const wavPath = await pickWav(dir, wav);

  const wave = sherpa.readWave(wavPath);
  const audioSeconds = wave.samples.length / wave.sampleRate;

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
      tokens: p.tokens,
      numThreads: threads,
      // Forced CPU. A discrete GPU on the developer's machine would make every
      // number here meaningless for the target user.
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
    decodingMethod: 'greedy_search',
  };

  const mem = watchMemory();
  const tLoad = performance.now();
  const recognizer = new sherpa.OfflineRecognizer(config);
  const loadMs = performance.now() - tLoad;

  const times = [];
  let text = '';
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    recognizer.decode(stream);
    const res = recognizer.getResult(stream);
    times.push(performance.now() - t);
    text = res.text ?? '';
  }
  const peakRss = mem.stop();

  const decodeMs = times.reduce((a, b) => a + b, 0) / times.length;
  const rtf = audioSeconds / (decodeMs / 1000);

  return {
    model,
    wav: path.basename(wavPath),
    sampleRate: wave.sampleRate,
    audioSeconds: +audioSeconds.toFixed(2),
    modelLoadMs: +loadMs.toFixed(0),
    decodeMsMean: +decodeMs.toFixed(0),
    decodeMsRuns: times.map((t) => +t.toFixed(0)),
    realtimeFactor: +rtf.toFixed(2),
    projected60minSeconds: +(3600 / rtf).toFixed(0),
    peakRssMiB: mib(peakRss),
    transcript: text,
  };
}

function report(r) {
  const proj = r.projected60minSeconds;
  const projStr = proj >= 60 ? `${(proj / 60).toFixed(1)} min` : `${proj} s`;
  return [
    `  model               ${r.model}`,
    `  clip                ${r.wav}  ${r.audioSeconds}s @ ${r.sampleRate} Hz`,
    `  model load          ${r.modelLoadMs} ms`,
    `  decode              ${r.decodeMsMean} ms${r.decodeMsRuns.length > 1 ? `  (runs: ${r.decodeMsRuns.join(', ')})` : ''}`,
    `  realtime factor     ${r.realtimeFactor}x`,
    `  → 60 min of audio   ${projStr}`,
    `  peak RSS            ${r.peakRssMiB} MiB`,
    `  transcript          ${JSON.stringify(r.transcript.slice(0, 90))}${r.transcript.length > 90 ? '…' : ''}`,
  ].join('\n');
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const hw = detectHardware();
  const threads = args.threads > 0 ? args.threads : Math.max(1, Math.min(4, hw.physicalCores));

  console.log(describe(hw));
  const warnings = validateTestBed(hw);
  if (warnings.length) {
    console.log('\n⚠  Not a valid M0 test bed — these numbers are an UPPER BOUND:');
    for (const w of warnings) console.log(`   · ${w}`);
  }
  console.log(
    `\nDecoding with ${threads} thread(s), provider forced to CPU.` +
      (threads < hw.physicalCores ? `  (capped to model the ${threads}-core target)` : '')
  );

  const sherpa = require('sherpa-onnx-node');
  console.log(`sherpa-onnx ${sherpa.version}  ·  onnxruntime ${sherpa.onnxruntimeVersion}\n`);

  const models = args.compare ? ['parakeet-v2', 'parakeet-v3'] : [args.model];

  // Both models must see identical audio, or the comparison is meaningless.
  let wav = args.wav;
  if (!wav) {
    const baseDir = await ensureModel(models[0]);
    wav = await pickWav(baseDir, null);
  }
  if (args.synth > 0) {
    const outPath = path.resolve('fixtures', `synth-${args.synth}min.wav`);
    const exists = await fsp.stat(outPath).then(() => true).catch(() => false);
    if (!exists) {
      console.log(`Building a ${args.synth}-minute clip by tiling ${path.basename(wav)}…`);
      await synthesizeLongWav(sherpa, wav, args.synth, outPath);
    }
    wav = outPath;
    console.log(`Throughput/memory probe on ${path.basename(wav)} — repeated speech, so ignore the transcript.\n`);
  }

  const results = [];
  for (const model of models) {
    console.log(`▸ ${model}`);
    const r = await benchModel({ model, wav, threads, runs: args.runs, sherpa });
    console.log(report(r) + '\n');
    results.push(r);
  }

  if (results.length > 1) {
    const [a, b] = results;
    console.log(
      `Comparison: ${a.model} ${a.realtimeFactor}x vs ${b.model} ${b.realtimeFactor}x  ` +
        `(${b.realtimeFactor >= a.realtimeFactor ? 'v3 faster or equal' : `v3 is ${((1 - b.realtimeFactor / a.realtimeFactor) * 100).toFixed(0)}% slower`})\n`
    );
  }

  const file = await saveResult('bench-asr', {
    hardware: hw,
    threads,
    sherpaVersion: sherpa.version,
    onnxruntimeVersion: sherpa.onnxruntimeVersion,
    validTestBed: warnings.length === 0,
    warnings,
    results,
  });
  console.log(`saved → ${path.relative(process.cwd(), file)}`);
}
