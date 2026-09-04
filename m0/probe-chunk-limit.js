/**
 * M0 · ASR maximum chunk length probe.
 *
 * Three findings drove the shape of this file, all discovered by running it:
 *
 *  1. Parakeet does NOT fail gracefully on long audio. Past a ceiling, the
 *     encoder's self-attention raises an onnxruntime broadcast error.
 *  2. That error is a NATIVE ABORT, not a catchable JS exception. A try/catch
 *     around the decode call does not save you, the process dies. So the real
 *     app must run ASR in a child process, and must never send an over-long
 *     chunk in the first place.
 *  3. Throughput degrades with chunk length (attention is quadratic), so short
 *     chunks are faster as well as safer. There is an optimum, and it is not
 *     "as long as the model allows".
 *
 * Each duration therefore runs in its own child process. The parent survives
 * every crash and records where the wall is.
 *
 * Usage: node m0/probe-chunk-limit.js [--model parakeet-v2] [--threads 4]
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { detectHardware, describe, validateTestBed, isMain } from './lib/hardware.js';
import { ensureModel, parakeetPaths } from './lib/models.js';
import { saveResult } from './lib/report.js';

const SELF = fileURLToPath(import.meta.url);

/* ------------------------------------------------------------------ child */

async function runChild(model, seconds, threads) {
  const require = createRequire(import.meta.url);
  const sherpa = require('sherpa-onnx-node');

  const dir = await ensureModel(model);
  const p = await parakeetPaths(dir);
  const wavDir = path.join(dir, 'test_wavs');
  const files = await fsp.readdir(wavDir);
  const wav = path.join(wavDir, files.find((f) => /^(en|0)\.wav$/.test(f)) ?? files[0]);
  const src = sherpa.readWave(wav);

  const want = Math.round(seconds * src.sampleRate);
  const samples = new Float32Array(want);
  for (let at = 0; at < want; at += src.samples.length) {
    samples.set(src.samples.subarray(0, Math.min(src.samples.length, want - at)), at);
  }

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
      tokens: p.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
    decodingMethod: 'greedy_search',
  });

  let peak = process.memoryUsage().rss;
  const mem = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, 50);
  mem.unref();

  const t = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: src.sampleRate, samples });
  recognizer.decode(stream);
  const res = recognizer.getResult(stream);
  const ms = performance.now() - t;
  clearInterval(mem);

  process.send?.({
    ok: true,
    seconds,
    ms: Math.round(ms),
    rtf: +(seconds / (ms / 1000)).toFixed(2),
    peakRssMiB: Math.round(peak / 1024 ** 2),
    chars: (res.text ?? '').length,
  });
}

/* ----------------------------------------------------------------- parent */

function attempt(model, seconds, threads) {
  return new Promise((resolve) => {
    const child = fork(SELF, ['--child', model, String(seconds), String(threads)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result = null;
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('message', (m) => (result = m));
    child.on('exit', (code, signal) => {
      if (result) return resolve(result);
      const line =
        stderr
          .split('\n')
          .map((s) => s.replace(/\x1b\[[0-9;]*m/g, '').trim())
          .find((s) => /Status Message|Error|error/.test(s)) ?? '';
      resolve({
        ok: false,
        seconds,
        crashed: true,
        exitCode: code,
        signal,
        error: line.slice(0, 170) || `exited ${code}${signal ? ` (${signal})` : ''} with no message`,
      });
    });
  });
}

async function probeModel(model, threads) {
  console.log(`▸ ${model}`);
  const ladder = [15, 30, 60, 120, 180, 240, 300, 360, 420, 600];
  const trials = [];
  let lastOk = 0;
  let firstFail = null;
  let error = '';

  for (const secs of ladder) {
    const r = await attempt(model, secs, threads);
    trials.push(r);
    if (r.ok) {
      console.log(
        `   ${String(secs).padStart(4)}s   ok    ${String(r.ms).padStart(6)} ms   ${String(r.rtf).padStart(5)}x   ${String(r.peakRssMiB).padStart(4)} MiB`
      );
      lastOk = secs;
    } else {
      console.log(`   ${String(secs).padStart(4)}s   CRASH  ${r.error}`);
      firstFail = secs;
      error = r.error;
      break;
    }
  }

  let ceiling = lastOk;
  if (firstFail !== null) {
    let lo = lastOk;
    let hi = firstFail;
    while (hi - lo > 5) {
      const mid = Math.round((lo + hi) / 2);
      const r = await attempt(model, mid, threads);
      trials.push(r);
      console.log(`   ${String(mid).padStart(4)}s   ${r.ok ? `ok    ${String(r.ms).padStart(6)} ms   ${String(r.rtf).padStart(5)}x` : 'CRASH'}   (bisect)`);
      if (r.ok) lo = mid;
      else hi = mid;
    }
    ceiling = lo;
  }

  const ok = trials.filter((t) => t.ok);
  const best = ok.reduce((a, b) => (b.rtf > a.rtf ? b : a), ok[0] ?? null);

  console.log(
    firstFail === null
      ? `   → no ceiling up to ${lastOk}s, extend the ladder\n`
      : `   → ceiling ≈ ${ceiling}s (${(ceiling / 60).toFixed(1)} min), crashes by ${firstFail}s\n` +
          `   → fastest chunk ${best?.seconds}s at ${best?.rtf}x  (a 60-min meeting ≈ ${(3600 / (best?.rtf ?? 1) / 60).toFixed(1)} min)\n`
  );

  return { model, threads, maxSeconds: ceiling, firstFailSeconds: firstFail, error, bestChunk: best, trials };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);

  if (argv[0] === '--child') {
    await runChild(argv[1], Number(argv[2]), Number(argv[3]));
    process.exit(0);
  }

  const modelArg = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null;
  const threadArg = argv.includes('--threads') ? parseInt(argv[argv.indexOf('--threads') + 1], 10) : 0;
  const hw = detectHardware();
  const threads = threadArg > 0 ? threadArg : Math.max(1, Math.min(4, hw.physicalCores));

  console.log(describe(hw));
  const warnings = validateTestBed(hw);
  if (warnings.length) console.log(`\n⚠  Upper-bound numbers, ${warnings.length} test-bed warning(s).`);
  console.log(`\nEach duration runs in its own process, because the failure mode is a native abort.\n`);

  const findings = [];
  for (const model of modelArg ? [modelArg] : ['parakeet-v2', 'parakeet-v3']) {
    findings.push(await probeModel(model, threads));
  }

  const smallest = Math.min(...findings.map((f) => f.maxSeconds));
  const file = await saveResult('asr-chunk-limit', { hardware: hw, threads, warnings, findings });

  console.log(`saved → ${path.relative(process.cwd(), file)}\n`);
  console.log('Implications for M2:');
  console.log(`  · Never hand the recogniser more than ${smallest}s of audio, it aborts the process, uncatchably.`);
  console.log(`  · Run ASR in a child process regardless, so a bad chunk cannot take the app down.`);
  console.log(`  · Chunk well below the ceiling: throughput falls as chunks grow, so short chunks win twice.`);
  console.log(`  · Split at VAD silence boundaries so no word is cut, and reassemble with offset timestamps.`);
}
