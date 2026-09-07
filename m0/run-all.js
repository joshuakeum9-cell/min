/**
 * M0 · run everything that can run unattended, then report what still needs a human.
 *
 * Two parts of M0 cannot be automated and should not be:
 *   · the capture probe needs a GUI and someone to pause the audio mid-recording
 *   · the counterfactual gate needs real meetings and a blind human reader
 * Both are reported as outstanding rather than quietly skipped.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { detectHardware, describe, validateTestBed, isMain } from './lib/hardware.js';
import { loadResults, saveResult } from './lib/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

const line = (s = '') => console.log(s);
const rule = (title) => {
  line();
  line('═'.repeat(72));
  line(`  ${title}`);
  line('═'.repeat(72));
  line();
};

if (isMain(import.meta.url)) {
  const hw = detectHardware();
  const warnings = validateTestBed(hw);

  rule('M0 · the spike');
  line(describe(hw));
  if (warnings.length) {
    line();
    line('⚠  NOT a valid M0 test bed. Everything below is an UPPER BOUND:');
    for (const w of warnings) line(`   · ${w}`);
    line();
    line('   The real run belongs on a 4-core / 8 GB / no-GPU machine with a call running.');
  }

  rule('1 · models');
  const gotModels = await run('lib/models.js', ['parakeet-v2', 'parakeet-v3', 'qwen3-4b', 'qwen3-1.7b']);

  rule('2 · ASR chunk ceiling');
  const gotLimit = gotModels && (await run('probe-chunk-limit.js'));

  rule('3 · ASR throughput');
  const gotAsr = gotModels && (await run('bench-asr.js', ['--compare', '--synth', '4']));

  rule('4 · LLM prefill and generation');
  const gotLlm = gotModels && (await run('bench-llm.js', ['--compare']));

  rule('M0 summary');

  const [limits, asr, llm] = await Promise.all([
    loadResults('asr-chunk-limit'),
    loadResults('bench-asr'),
    loadResults('bench-llm'),
  ]);

  const last = (a) => (a.length ? a[a.length - 1] : null);
  const L = last(limits);
  const A = last(asr);
  const M = last(llm);

  if (L) {
    const ceiling = Math.min(...L.findings.map((f) => f.maxSeconds));
    line(`ASR chunk ceiling      ${ceiling}s (${(ceiling / 60).toFixed(1)} min), a native abort, not catchable`);
    for (const f of L.findings) {
      if (f.bestChunk) {
        line(
          `  ${f.model.padEnd(13)} fastest at ${String(f.bestChunk.seconds).padStart(3)}s = ${f.bestChunk.rtf}x ` +
            `→ 60 min of audio in ${(3600 / f.bestChunk.rtf / 60).toFixed(1)} min`
        );
      }
    }
  }

  if (M) {
    line();
    for (const r of M.results) {
      const warm = (r.contextCreateMs + r.prefillMs + r.generateMs) / 1000;
      line(
        `${r.model.padEnd(13)} prefill ${String(r.prefillTokensPerSec).padStart(7)} tok/s · ` +
          `generate ${String(r.generateTokensPerSec).padStart(6)} tok/s · note in ${warm.toFixed(0)}s warm · ${r.peakRssMiB} MiB`
      );
    }
  }

  line();
  line('Still outstanding, these are the two that actually decide the project:');
  line();
  line('  □  Capture integrity        npm run m0:capture');
  line('     Needs you to pause the audio mid-recording. Answers whether loopback');
  line('     drops frames during silence, which decides if the timeline needs');
  line('     gap reconstruction.');
  line();
  line('  □  THE GATE                 node m0/eval-counterfactual.js generate');
  line('     Needs 10 real meetings with the sloppy notes you actually typed.');
  line('     Bar: 7 of 10 pairs correctly identified by a blind reader.');
  line('     If this fails, the local-first default is wrong and you want to know now.');
  line();

  await saveResult('m0-summary', {
    hardware: hw,
    validTestBed: warnings.length === 0,
    warnings,
    stages: { models: gotModels, chunkLimit: gotLimit, asr: gotAsr, llm: gotLlm },
    outstanding: ['capture-integrity', 'counterfactual-gate'],
  });

  const fixtures = await fsp.readdir(path.join(HERE, '..', 'fixtures', 'meetings')).catch(() => []);
  if (fixtures.length < 10) {
    line(`fixtures/meetings has ${fixtures.length} meeting(s). The gate wants 10 real ones.`);
    line();
  }
}
