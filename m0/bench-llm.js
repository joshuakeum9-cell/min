/**
 * M0 · LLM prefill and generation benchmark.
 *
 * The research was explicit that this number is unmeasured: "the one number that
 * matters, CPU-only prefill and generation on a 4-core no-GPU laptop, appears
 * nowhere."
 *
 * Design note, learned the hard way: the first version of this file did one
 * 13k-token prefill and printed nothing until it finished. It ran for over half
 * an hour and produced no data at all when interrupted. A benchmark whose only
 * output arrives at the end is useless, because the interesting case is exactly
 * the one that takes too long.
 *
 * So this sweeps prefill length from short to long, smallest model first, and
 * prints every measurement the moment it lands. Partial results are real results.
 * Each step has a wall-clock budget; exceeding it is a finding, not a failure,
 * and the sweep stops rather than grinding on.
 *
 * The two costs are separate and scale differently:
 *   prefill   , reading the transcript. Grows with meeting length.
 *   generation, writing the note. Roughly fixed, ~800 tokens.
 * A single combined number hides which half is the problem.
 *
 * Usage:
 *   node m0/bench-llm.js                     # both tiers, CPU, full sweep
 *   node m0/bench-llm.js --model qwen3-1.7b
 *   node m0/bench-llm.js --quick             # short lengths only
 *   node m0/bench-llm.js --budget 240        # per-step seconds before giving up
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { detectHardware, describe, validateTestBed, isMain } from './lib/hardware.js';
import { ensureModel, llmPath } from './lib/models.js';
import { saveResult } from './lib/report.js';

/** Transcript token counts to sweep. 13k ≈ a 60-minute meeting. */
const SWEEP = [500, 2000, 6000, 13000];
const QUICK = [500, 2000];

function parseArgs(argv) {
  const a = { model: null, quick: false, budget: 300, threads: 4, gpu: false, noteTokens: 400 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--model') a.model = argv[++i];
    else if (k === '--quick') a.quick = true;
    else if (k === '--budget') a.budget = parseInt(argv[++i], 10);
    else if (k === '--threads') a.threads = parseInt(argv[++i], 10);
    else if (k === '--note-tokens') a.noteTokens = parseInt(argv[++i], 10);
    else if (k === '--gpu') a.gpu = true;
  }
  return a;
}

const say = (s) => {
  process.stdout.write(s);
  if (process.stdout.flush) process.stdout.flush();
};

const LINES = [
  'We should push the pilot to the second week of October, the data team is not ready.',
  'That works, but it compresses the review window to four days.',
  'Four days is enough if we get the schema frozen by Friday.',
  'I can freeze the schema Thursday if nobody adds fields after tomorrow.',
  'What is the fallback if the vendor slips again?',
  'We run the manual export one more cycle. It is ugly but it is known.',
  'I do not want to run manual export in December, that is the busy period.',
  'Then we need the vendor commitment in writing this week.',
  'Do we need legal on the data processing addendum before the pilot?',
  'Yes, and legal takes ten working days, so that starts now.',
];

/** Build a transcript of approximately N tokens, measured with the real tokenizer. */
function buildTranscript(llm, targetTokens) {
  let text = '';
  let i = 0;
  let seconds = 0;
  // Grow in blocks, then trim back, tokenizing every line would dominate the run.
  while (llm.tokenize(text).length < targetTokens) {
    const block = [];
    for (let k = 0; k < 25; k++) {
      const who = i % 3 === 0 ? 'Them' : 'You';
      const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      block.push(`[${hh}:${mm}:${ss}] ${who}: ${LINES[i % LINES.length]}`);
      seconds += 7;
      i++;
    }
    text += (text ? '\n' : '') + block.join('\n');
  }
  const lines = text.split('\n');
  while (lines.length > 1 && llm.tokenize(lines.join('\n')).length > targetTokens) lines.pop();
  return lines.join('\n');
}

const USER_NOTES = `# Timeline
- pilot slipping?
- schema freeze friday

# Risks
- vendor again
- legal DPA lead time

# Mine
- open the ticket`;

const SYSTEM = `You enhance a person's own meeting notes using the transcript.

Rules:
- The user's notes are the skeleton. Keep their headings, their order, their wording.
- Add only detail that is present in the transcript.
- Never invent names, numbers, dates or commitments.
- Do not turn proposals into decisions.
- Keep their voice. Do not rewrite plain speech into corporate phrasing.
- No preamble. Start with the first heading.`;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} exceeded ${ms / 1000}s budget`)), ms);
    }),
  ]);
}

async function measureOne({ llm, LlamaChatSession, QwenChatWrapper, transcript, noteTokens, budgetMs, threads }) {
  const prompt = `Transcript:\n${transcript}\n\nMy notes:\n${USER_NOTES}\n\nEnhance my notes.`;
  const promptTokens = llm.tokenize(prompt).length;
  const contextSize = Math.min(
    llm.trainContextSize ?? 32768,
    Math.max(2048, promptTokens + noteTokens + 1024)
  );

  const tCtx = performance.now();
  const context = await llm.createContext({ contextSize, threads });
  const ctxMs = performance.now() - tCtx;

  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: SYSTEM,
    // Qwen3 is a hybrid thinking model and reasons by default. On CPU that is
    // fatal: measured on Qwen3-1.7B, a trivial prompt spent 34 s emitting 585
    // characters of invisible chain-of-thought and returned an EMPTY answer.
    // Discouraging thoughts took the same prompt to 6.7 s with real output.
    // Every reasoning token is a token the user waits for and never sees.
    chatWrapper: new QwenChatWrapper({ thoughts: 'discourage' }),
  });

  let peak = process.memoryUsage().rss;
  const mem = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peak) peak = r;
  }, 200);
  mem.unref();

  let firstTokenAt = null;
  let generated = '';
  const tStart = performance.now();

  try {
    await withTimeout(
      session.prompt(prompt, {
        maxTokens: noteTokens,
        temperature: 0.3,
        onTextChunk(chunk) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          generated += chunk;
        },
      }),
      budgetMs,
      `${promptTokens}-token prefill`
    );
  } catch (err) {
    clearInterval(mem);
    await context.dispose();
    return { promptTokens, contextSize, timedOut: true, error: err.message, budgetMs };
  }

  const tEnd = performance.now();
  clearInterval(mem);

  const prefillMs = (firstTokenAt ?? tEnd) - tStart;
  const genMs = tEnd - (firstTokenAt ?? tStart);
  const genTokens = llm.tokenize(generated).length;
  await context.dispose();

  return {
    promptTokens,
    contextSize,
    timedOut: false,
    contextCreateMs: Math.round(ctxMs),
    prefillMs: Math.round(prefillMs),
    prefillTokensPerSec: +(promptTokens / (prefillMs / 1000)).toFixed(1),
    generateMs: Math.round(genMs),
    generatedTokens: genTokens,
    generateTokensPerSec: +(genTokens / (genMs / 1000)).toFixed(2),
    warmTotalMs: Math.round(ctxMs + prefillMs + genMs),
    peakRssMiB: Math.round(peak / 1024 ** 2),
    sample: generated.slice(0, 200),
  };
}

async function benchModel({ model, lengths, noteTokens, budget, threads, gpu }) {
  const { getLlama, LlamaChatSession, QwenChatWrapper } = await import('node-llama-cpp');
  await ensureModel(model);

  say(`▸ ${model}   loading… `);
  const tLoad = performance.now();
  const llama = await getLlama({ gpu: gpu ? 'auto' : false });
  const llm = await llama.loadModel({ modelPath: llmPath(model) });
  const loadMs = performance.now() - tLoad;
  say(`${(loadMs / 1000).toFixed(1)}s\n`);
  say(`   ${'prompt'.padStart(7)} ${'ctx'.padStart(7)} ${'prefill'.padStart(9)} ${'tok/s'.padStart(8)} ${'gen'.padStart(8)} ${'tok/s'.padStart(7)} ${'warm'.padStart(8)} ${'RSS'.padStart(7)}\n`);

  const steps = [];
  for (const target of lengths) {
    const transcript = buildTranscript(llm, target);
    const r = await measureOne({
      llm,
      LlamaChatSession,
      QwenChatWrapper,
      transcript,
      noteTokens,
      budgetMs: budget * 1000,
      threads,
    });
    steps.push(r);

    if (r.timedOut) {
      say(`   ${String(r.promptTokens).padStart(7)} ${String(r.contextSize).padStart(7)}   TIMED OUT after ${budget}s — stopping sweep\n`);
      break;
    }
    say(
      `   ${String(r.promptTokens).padStart(7)} ${String(r.contextSize).padStart(7)} ` +
        `${(r.prefillMs / 1000).toFixed(1).padStart(8)}s ${String(r.prefillTokensPerSec).padStart(8)} ` +
        `${(r.generateMs / 1000).toFixed(1).padStart(7)}s ${String(r.generateTokensPerSec).padStart(7)} ` +
        `${(r.warmTotalMs / 1000).toFixed(1).padStart(7)}s ${String(r.peakRssMiB).padStart(6)}M\n`
    );
  }

  await llm.dispose();
  return { model, backend: gpu ? 'gpu-auto' : 'cpu', threads, modelLoadMs: Math.round(loadMs), steps };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const hw = detectHardware();
  const lengths = args.quick ? QUICK : SWEEP;

  console.log(describe(hw));
  const warnings = validateTestBed(hw);
  if (warnings.length) {
    console.log('\n⚠  Not a valid M0 test bed — UPPER BOUND only:');
    for (const w of warnings) console.log(`   · ${w}`);
  }
  if (args.gpu) console.log('\n⚠  --gpu is for contrast only. The target user has no discrete GPU.');

  console.log(
    `\nSweeping prefill at ${lengths.join(', ')} tokens · ${args.threads} threads · ` +
      `note cap ${args.noteTokens} · ${args.budget}s budget per step`
  );
  console.log(`13k tokens ≈ a 60-minute meeting.\n`);

  // Smallest model first, so there is data on the board before the slow one runs.
  const models = args.model ? [args.model] : ['qwen3-1.7b', 'qwen3-4b'];
  const results = [];
  for (const model of models) {
    results.push(await benchModel({ ...args, model, lengths }));
    console.log();
  }

  const PASS_SECONDS = 360; // M0 gate: a note in under 6 minutes on the weak machine
  const SCALE = 1.5; // this box is ~1.5x the 4-core target
  console.log('Projection to the 4-core target (this machine × 1.5):\n');
  for (const r of results) {
    const full = r.steps.find((s) => !s.timedOut && s.promptTokens >= 12000);
    if (!full) {
      console.log(`  ${r.model.padEnd(12)} no completed 13k step — 60-minute meetings are out of reach here`);
      continue;
    }
    const scaled = (full.warmTotalMs / 1000) * SCALE;
    console.log(
      `  ${r.model.padEnd(12)} ${(full.warmTotalMs / 1000).toFixed(0)}s here → ~${scaled.toFixed(0)}s on target  ` +
        `${scaled < PASS_SECONDS ? '✓ within the 6-minute gate' : '✗ EXCEEDS the 6-minute gate'}`
    );
  }

  const file = await saveResult('bench-llm', {
    hardware: hw,
    validTestBed: warnings.length === 0,
    warnings,
    lengths,
    noteTokens: args.noteTokens,
    budgetSeconds: args.budget,
    results,
  });
  console.log(`\nsaved → ${path.relative(process.cwd(), file)}`);
}
