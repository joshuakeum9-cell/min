/**
 * M0 · The counterfactual-notes test.
 *
 * This is the gate. Everything else in M0 is engineering measurement; this one
 * decides whether the product thesis is real.
 *
 * The claim being tested: the app "enhances YOUR notes with the transcript"
 * rather than "summarises the transcript". If that claim is true, swapping in a
 * DIFFERENT meeting's notes must visibly change the output. If a blind reader
 * cannot tell which note was built from the correct input, then the model is
 * ignoring the user's notes and writing a summary, and the entire premise of
 * the product is a costume.
 *
 * Protocol:
 *   1. generate , for each meeting, produce two notes from the SAME transcript:
 *                  one with the user's real notes, one with another meeting's
 *                  notes. Shuffle which is A and which is B. Write the key
 *                  separately so the reader cannot peek.
 *   2. score    , a blind reader picks, for each pair, which note used the real
 *                  notes. 7 of 10 correct is the pass mark.
 *
 * A deterministic anchor-retention metric runs alongside as a cheap early
 * signal, but it does NOT replace the human read. A model can echo the user's
 * vocabulary while still flattening their voice, and only a person sees that.
 *
 * Usage:
 *   node m0/eval-counterfactual.js --make-fixtures     # writes example meetings
 *   node m0/eval-counterfactual.js generate            # build the blind pairs
 *   node m0/eval-counterfactual.js score               # record your judgements
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { detectHardware, isMain } from './lib/hardware.js';
import { ensureModel, llmPath } from './lib/models.js';
import { RESULTS_DIR, saveResult } from './lib/report.js';
import { fileURLToPath } from 'node:url';

// Anchored to the repository rather than the working directory, so the gate
// looks in the same place whichever folder it is started from.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES = path.join(REPO, 'fixtures', 'meetings');
const PASS_RATIO = 0.7; // 7 of 10

const SYSTEM = `You enhance a person's own meeting notes using the transcript.

Rules:
- The user's notes are the skeleton. Keep their headings, their order, their wording.
- Add only detail that is present in the transcript.
- Never invent names, numbers, dates or commitments.
- Do not turn proposals into decisions.
- Keep their voice. Do not rewrite plain speech into corporate phrasing.
- No preamble. Start with the first heading.`;

/* --------------------------------------------------------------- fixtures */

async function loadMeetings() {
  const dirs = await fsp.readdir(FIXTURES, { withFileTypes: true }).catch(() => []);
  const meetings = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const base = path.join(FIXTURES, d.name);
    const [transcript, notes] = await Promise.all([
      fsp.readFile(path.join(base, 'transcript.md'), 'utf8').catch(() => null),
      fsp.readFile(path.join(base, 'my-notes.md'), 'utf8').catch(() => null),
    ]);
    if (transcript && notes) meetings.push({ id: d.name, transcript, notes });
  }
  return meetings;
}

/* -------------------------------------------------------------- generation */

async function generateNote(session, transcript, notes, maxTokens = 700) {
  const prompt = `Transcript:\n${transcript}\n\nMy notes:\n${notes}\n\nEnhance my notes.`;
  return session.prompt(prompt, { maxTokens, temperature: 0.3 });
}

/**
 * Anchor retention: what fraction of the distinctive words in the user's notes
 * survive into the output. Cheap, deterministic, and a useful early smell test ,
 * but a high score does not prove the note reads like the user wrote it.
 */
const STOP = new Set(
  ('the a an and or but if then to of in on for with at by from as is are was were be been ' +
    'this that these those it its we i you they he she our your their my me do does did not no ' +
    'can will would should could have has had more most some any all one two new next').split(' ')
);

function anchorTokens(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

function anchorRetention(notes, output) {
  const want = anchorTokens(notes);
  if (want.size === 0) return 1;
  const got = anchorTokens(output);
  let hit = 0;
  for (const w of want) if (got.has(w)) hit++;
  return +(hit / want.size).toFixed(3);
}

/** Deterministic shuffle, the run is reproducible from its own key file. */
function seededPick(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

async function generate(modelName) {
  const meetings = await loadMeetings();
  if (meetings.length < 2) {
    console.error(
      `Need at least 2 meetings in ${FIXTURES}.\n` +
        `Each is a folder containing transcript.md and my-notes.md.\n` +
        `Run with --make-fixtures for examples, then replace them with your real meetings.`
    );
    process.exit(1);
  }
  if (meetings.length < 10) {
    console.log(`⚠  Only ${meetings.length} meetings. The 7-of-10 gate assumes 10, treat this as a smoke test.\n`);
  }

  const { getLlama, LlamaChatSession, QwenChatWrapper } = await import('node-llama-cpp');
  await ensureModel(modelName);
  console.log(`Loading ${modelName} on CPU…`);
  const llama = await getLlama({ gpu: false });
  const llm = await llama.loadModel({ modelPath: llmPath(modelName) });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(RESULTS_DIR, `counterfactual-${stamp}`);
  await fsp.mkdir(outDir, { recursive: true });

  const rand = seededPick(meetings.length * 7919);
  const key = [];

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    const other = meetings[(i + 1 + Math.floor(rand() * (meetings.length - 1))) % meetings.length];
    const decoy = other.id === m.id ? meetings[(i + 1) % meetings.length] : other;

    process.stdout.write(`  ${m.id}  (decoy notes from ${decoy.id})… `);
    const t = performance.now();

    const notes = [];
    for (const [label, noteText] of [['real', m.notes], ['decoy', decoy.notes]]) {
      const ctx = await llm.createContext({
        contextSize: Math.min(
          llm.trainContextSize ?? 32768,
          Math.max(4096, llm.tokenize(m.transcript + noteText).length + 1600)
        ),
      });
      const session = new LlamaChatSession({
        contextSequence: ctx.getSequence(),
        systemPrompt: SYSTEM,
        // Qwen3 is a hybrid thinking model and reasons by default. On CPU that is
        // fatal: measured on Qwen3-1.7B, a trivial prompt spent 34 s emitting 585
        // characters of invisible chain-of-thought and returned an EMPTY answer.
        // Discouraging thoughts took the same prompt to 6.7 s with real output.
        // Every reasoning token is a token the user waits for and never sees.
        chatWrapper: new QwenChatWrapper({ thoughts: 'discourage' }),
      });
      const out = await generateNote(session, m.transcript, noteText);
      await ctx.dispose();
      notes.push({ label, noteText, out });
    }

    const realFirst = rand() < 0.5;
    const [A, B] = realFirst ? [notes[0], notes[1]] : [notes[1], notes[0]];

    await fsp.writeFile(
      path.join(outDir, `${m.id}.md`),
      `# ${m.id}\n\n## The notes that were typed during this meeting\n\n${m.notes}\n\n` +
        `---\n\n## Version A\n\n${A.out}\n\n---\n\n## Version B\n\n${B.out}\n`
    );

    key.push({
      meeting: m.id,
      decoyFrom: decoy.id,
      answer: realFirst ? 'A' : 'B',
      anchorRetentionReal: anchorRetention(m.notes, notes[0].out),
      anchorRetentionDecoy: anchorRetention(m.notes, notes[1].out),
      ms: Math.round(performance.now() - t),
    });
    console.log(`${((performance.now() - t) / 1000).toFixed(0)}s`);
  }

  await llm.dispose();
  await fsp.writeFile(path.join(outDir, '_key.json'), JSON.stringify({ model: modelName, key }, null, 2) + '\n');

  const meanReal = key.reduce((a, k) => a + k.anchorRetentionReal, 0) / key.length;
  const meanDecoy = key.reduce((a, k) => a + k.anchorRetentionDecoy, 0) / key.length;

  console.log(`\nWrote ${key.length} blind pairs → ${path.relative(process.cwd(), outDir)}`);
  console.log(`\nAutomated early signal (not the gate):`);
  console.log(`  anchor retention, real notes   ${meanReal.toFixed(3)}`);
  console.log(`  anchor retention, decoy notes  ${meanDecoy.toFixed(3)}`);
  console.log(`  separation                     ${(meanReal - meanDecoy).toFixed(3)}`);
  console.log(
    meanReal - meanDecoy < 0.15
      ? `  ⚠  Weak separation. The model may be ignoring the notes, read the pairs closely.`
      : `  ✓  The real notes leave a measurably stronger trace.`
  );
  console.log(
    `\nNow read the pairs WITHOUT opening _key.json, then run:\n  node m0/eval-counterfactual.js score\n`
  );
}

/* ----------------------------------------------------------------- scoring */

async function score() {
  const dirs = (await fsp.readdir(RESULTS_DIR, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && d.name.startsWith('counterfactual-'))
    .map((d) => d.name)
    .sort();
  if (!dirs.length) {
    console.error('No counterfactual run found. Run "generate" first.');
    process.exit(1);
  }
  const dir = path.join(RESULTS_DIR, dirs[dirs.length - 1]);
  const { model, key } = JSON.parse(await fsp.readFile(path.join(dir, '_key.json'), 'utf8'));

  console.log(`Scoring ${dirs[dirs.length - 1]}  (${model})\n`);
  console.log(`For each meeting, open ${path.relative(process.cwd(), dir)}/<name>.md,`);
  console.log(`read Version A and Version B, and say which one was built from the notes shown at the top.\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answers = [];
  for (const k of key) {
    let pick = '';
    while (!['a', 'b', 's'].includes(pick)) {
      pick = (await rl.question(`  ${k.meeting.padEnd(28)} A / B  (s to skip): `)).trim().toLowerCase();
    }
    if (pick === 's') continue;
    answers.push({ meeting: k.meeting, picked: pick.toUpperCase(), answer: k.answer, correct: pick.toUpperCase() === k.answer });
  }
  await rl.close();

  const correct = answers.filter((a) => a.correct).length;
  const ratio = answers.length ? correct / answers.length : 0;
  const passed = ratio >= PASS_RATIO;

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${correct} of ${answers.length} identified correctly  (${(ratio * 100).toFixed(0)}%)`);
  console.log(`  gate: ${(PASS_RATIO * 100).toFixed(0)}%`);
  console.log(`\n  ${passed ? '✓  PASS, the model is genuinely using the notes.' : '✗  FAIL, the enhancement is a summariser wearing a costume.'}`);
  if (!passed) {
    console.log(
      `\n  This is the decision the whole spike exists to force. The architecture is\n` +
        `  not wrong, but the default must change: either move more structure out of\n` +
        `  the prompt and into code (headings, grammar, anchor checks), or make\n` +
        `  bring-your-own-key the default path and local the fallback.\n` +
        `  Better to know this now than after three months of Electron work.`
    );
  }
  console.log(`${'─'.repeat(58)}\n`);

  const file = await saveResult('counterfactual', {
    hardware: detectHardware(),
    run: dirs[dirs.length - 1],
    model,
    correct,
    total: answers.length,
    ratio: +ratio.toFixed(3),
    passed,
    answers,
    anchorSignal: key.map((k) => ({
      meeting: k.meeting,
      real: k.anchorRetentionReal,
      decoy: k.anchorRetentionDecoy,
    })),
  });
  console.log(`saved → ${path.relative(process.cwd(), file)}`);
}

/* ---------------------------------------------------------------- example */

const EXAMPLES = [
  {
    id: '01-vendor-pilot',
    notes: `# Timeline\n- pilot slipping?\n- schema freeze friday\n\n# Risks\n- vendor again\n- legal DPA takes ages\n\n# Mine\n- open the ticket`,
    lines: [
      ['Them', 'We should push the pilot to the second week of October, the data team is not ready.'],
      ['You', 'That works but it compresses the review window to four days.'],
      ['Them', 'Four days is enough if we get the schema frozen by Friday.'],
      ['You', 'I can freeze it Thursday if nobody adds fields after tomorrow.'],
      ['Them', 'What is the fallback if the vendor slips again?'],
      ['You', 'We run the manual export one more cycle. It is ugly but it is known.'],
      ['You', 'I do not want to run manual export in December, that is the busy period.'],
      ['Them', 'Then we need the vendor commitment in writing this week.'],
      ['You', 'Do we need legal on the data processing addendum before the pilot?'],
      ['Them', 'Yes, and legal takes ten working days, so that starts now.'],
      ['You', 'I will open the ticket this afternoon.'],
    ],
  },
  {
    id: '02-hiring-loop',
    notes: `# Loop\n- 5 rounds is too many\n- cut the take-home?\n\n# Candidates\n- 2 strong, 1 maybe\n\n# Mine\n- rewrite the rubric`,
    lines: [
      ['You', 'Five rounds is too many, we are losing people at round three.'],
      ['Them', 'The take-home is where most of the drop-off happens.'],
      ['You', 'Can we replace it with a paired session in the same slot?'],
      ['Them', 'That doubles interviewer load, we would need four more trained interviewers.'],
      ['You', 'How many did we train last quarter?'],
      ['Them', 'Two. And one has since moved teams.'],
      ['You', 'So realistically we cut a round instead.'],
      ['Them', 'Of the current pool, two are strong and one is a maybe pending references.'],
      ['You', 'I will rewrite the rubric before the next panel.'],
    ],
  },
  {
    id: '03-infra-costs',
    notes: `# Spend\n- up 40%? why\n- storage vs compute\n\n# Actions\n- tag everything\n- kill the staging cluster`,
    lines: [
      ['Them', 'Spend is up about forty percent quarter on quarter.'],
      ['You', 'Is that storage or compute?'],
      ['Them', 'Mostly storage. We never set a retention policy on the event logs.'],
      ['You', 'So we are paying to keep logs nobody reads.'],
      ['Them', 'Correct. And the staging cluster has been up since March doing nothing.'],
      ['You', 'Kill it. What stops us tagging everything so we can see this sooner?'],
      ['Them', 'Nothing stops us, it is just nobody owns it.'],
      ['You', 'I will own it. Tagging first, then a retention policy on the logs.'],
    ],
  },
];

async function makeFixtures() {
  await fsp.mkdir(FIXTURES, { recursive: true });
  for (const ex of EXAMPLES) {
    const dir = path.join(FIXTURES, ex.id);
    await fsp.mkdir(dir, { recursive: true });
    let s = 0;
    const transcript = ex.lines
      .map(([who, text]) => {
        const line = `[00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}] ${who}: ${text}`;
        s += 17;
        return line;
      })
      .join('\n');
    await fsp.writeFile(path.join(dir, 'transcript.md'), transcript + '\n');
    await fsp.writeFile(path.join(dir, 'my-notes.md'), ex.notes + '\n');
  }
  console.log(`Wrote ${EXAMPLES.length} example meetings → ${path.relative(process.cwd(), FIXTURES)}\n`);
  console.log(
    `These exist so the harness runs today. They are short and clean, and real\n` +
      `meetings are neither, so a pass on these is NOT a pass on the gate.\n` +
      `Replace them with 10 real meetings: for each, a folder with transcript.md\n` +
      `and my-notes.md holding the notes you actually typed at the time.\n`
  );
}

/* -------------------------------------------------------------------- main */

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const modelArg = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'qwen3-4b';

  if (argv.includes('--make-fixtures')) await makeFixtures();
  else if (argv[0] === 'score') await score();
  else if (argv[0] === 'generate') await generate(modelArg);
  else {
    console.log(
      'The counterfactual-notes test, the M0 gate.\n\n' +
        '  node m0/eval-counterfactual.js --make-fixtures   write example meetings\n' +
        '  node m0/eval-counterfactual.js generate          build blind A/B pairs\n' +
        '  node m0/eval-counterfactual.js score             record your judgements\n\n' +
        `Pass mark: ${(PASS_RATIO * 100).toFixed(0)}% of pairs correctly identified by a blind reader.\n`
    );
  }
}
