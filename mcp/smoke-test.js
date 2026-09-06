/**
 * MCP smoke test, drives the real server over a real stdio transport.
 *
 * Deliberately uses the SDK client rather than hand-rolled JSON-RPC, so this
 * exercises the same handshake an actual assistant performs. A server that
 * "looks right" but fails the initialize round-trip would pass any lesser test.
 *
 * The meetings are built here, in a temp directory, and the server is pointed at
 * them through its environment. Three of the five tools need a meeting on disk,
 * and the only other way to reach them is the owner's real Meetings folder,
 * where the sole test of save_writeup is to overwrite a real note and put it
 * back afterwards: one crash between those two calls and the note is gone. A
 * built fixture also makes the ambiguity and search checks mean something, since
 * both depend on what happens to be on disk.
 *
 * Run: node mcp/smoke-test.js
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.js');

let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ' , ' + extra : ''}`);
};

/*
 * Two meetings, not one. The refusal path in matchMeeting can only fire when a
 * fragment really does match more than one folder, so on a machine with a single
 * meeting the old check scored "no error" as a pass and proved nothing. "vendor"
 * is in both titles here by construction, and "statutes" in exactly one
 * transcript, which is what makes the search result a number and not a guess.
 */
const FIXTURES = [
  {
    id: '2026-09-03-1400-vendor-sync',
    title: 'Vendor sync',
    startedAt: '2026-09-03T14:00:00.000Z',
    endedAt: '2026-09-03T14:25:00.000Z',
    durationSeconds: 1500,
    notes: '# Vendor sync\n\n- pricing, three year lock?\n- who owns the statutes clause\n',
    transcript:
      '[00:00:04] You: Where did we land on the statutes clause?\n' +
      '[00:00:11] Them: We drop it if you take the three year lock.\n',
  },
  {
    id: '2026-09-04-0930-vendor-legal',
    title: 'Vendor legal review',
    startedAt: '2026-09-04T09:30:00.000Z',
    endedAt: '2026-09-04T09:48:00.000Z',
    durationSeconds: 1080,
    notes: '# Vendor legal review\n\n- redlines back by Friday\n',
    transcript:
      '[00:00:06] You: Legal wants the indemnity cap halved.\n' +
      '[00:00:14] Them: Send the redline over and we will look on Friday.\n',
  },
];

async function writeFixture(root) {
  for (const m of FIXTURES) {
    const dir = path.join(root, 'Meetings', m.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'my-notes.md'), m.notes);
    await fsp.writeFile(path.join(dir, 'transcript.md'), m.transcript);
    await fsp.writeFile(
      path.join(dir, 'meeting.json'),
      JSON.stringify(
        {
          title: m.title,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          durationSeconds: m.durationSeconds,
          // Complete, so nothing here reads as a meeting still owed a pass over
          // audio that was never written.
          transcript: { at: m.endedAt, engine: 'sherpa-onnx', utterances: 2, complete: true },
          audioDisposition: 'deleted after successful transcription',
        },
        null,
        2
      ) + '\n'
    );
  }
}

/** Every file under a directory, so the test can assert WHERE the server wrote. */
async function walk(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function run(client, root) {
  const call = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content?.[0]?.text ?? '', refused: Boolean(r.isError) };
    } catch (err) {
      // A refusal reaches the caller either as an isError result or as a
      // rejection, depending on the SDK version. Both mean the tool said no, and
      // a test that only handles one of them scores the other as a pass.
      return { text: String(err?.message ?? err), refused: true };
    }
  };
  const say = async (name, args) => (await call(name, args)).text;

  // --- tools are advertised ---
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('tools:', names.join(', '), '\n');
  ok('all five tools registered', names.length === 5);
  for (const want of ['list_meetings', 'read_meeting', 'save_writeup', 'search_meetings', 'writing_guidance']) {
    ok(`  ${want}`, names.includes(want));
  }

  // --- list ---
  const list = await say('list_meetings', { limit: 10 });
  const listed = [...list.matchAll(/^- (\S+)$/gm)].map((m) => m[1]).sort();
  const isolated =
    listed.length === FIXTURES.length && listed.every((id) => FIXTURES.some((f) => f.id === id));
  ok('list_meetings returns the fixture and nothing else', isolated, listed.join(', ') || 'nothing listed');
  ok('list_meetings reports state per meeting', /transcribed, no write-up yet/.test(list));
  if (!isolated) {
    // Everything below this line writes. If the environment redirect did not
    // take, the folder underneath is the owner's real one, so stop here rather
    // than save a write-up into it.
    throw new Error('server is not pointed at the temp meetings folder, refusing to write');
  }

  const [sync, legal] = FIXTURES;

  // --- read ---
  const read = await say('read_meeting', { meeting: sync.id });
  ok(
    'read_meeting returns notes and transcript',
    read.includes('Notes the user typed') && read.includes('## Transcript') &&
      read.includes('statutes clause')
  );
  const noTranscript = await say('read_meeting', { meeting: sync.id, include_transcript: false });
  ok('include_transcript false leaves the transcript out', !noTranscript.includes('## Transcript'));

  // --- fuzzy resolution ---
  // A unique fragment must resolve; an ambiguous one must REFUSE and say why,
  // rather than silently picking a meeting the user did not mean.
  const stamp = legal.id.slice(0, 16);
  const fuzzy = await say('read_meeting', { meeting: stamp, include_transcript: false });
  ok('resolves a unique fragment', fuzzy.includes(legal.title), `"${stamp}"`);

  const ambiguous = await call('read_meeting', { meeting: 'vendor' });
  ok(
    'refuses an ambiguous name instead of guessing',
    ambiguous.refused && /matches 2 meetings/.test(ambiguous.text),
    ambiguous.text.slice(0, 60)
  );

  // --- search ---
  const hit = await say('search_meetings', { query: 'statutes' });
  ok('search finds a known phrase in one meeting', /1 match\(es\)/.test(hit) && hit.includes(sync.id));
  ok('search markers converted to markdown', !hit.includes('\u0001') && hit.includes('**'));
  const miss = await say('search_meetings', { query: 'defenestration' });
  ok('search says so when nothing matches', /Nothing matches/.test(miss));
  const written = await walk(root);
  ok('the index was built inside the temp folder', written.some((f) => f.endsWith('mcp-index.db')));

  // --- guidance ---
  const guide = await say('writing_guidance');
  ok('guidance states the thesis', guide.includes('skeleton') && guide.includes('would read the same'));

  // --- save ---
  const marker = '# Smoke test\n\nWritten by mcp/smoke-test.js.';
  const saved = await say('save_writeup', { meeting: sync.id, content: marker });
  ok('save_writeup reports characters written', /Saved [\d,]+ characters/.test(saved));

  const reread = await say('read_meeting', { meeting: sync.id, include_transcript: false });
  ok('write-up is readable straight back', reread.includes('## Existing write-up') && reread.includes('Smoke test'));

  const onDisk = await fsp
    .readFile(path.join(root, 'Meetings', sync.id, 'note.md'), 'utf8')
    .catch(() => '');
  ok('note.md landed in the meeting folder', onDisk.startsWith('# Smoke test'));

  // The cap on save_writeup is the only bound on the one write an outside client
  // drives, so it is worth a shot rather than trust. One byte over
  // MAX_WRITEUP_BYTES in server.js.
  const huge = await call('save_writeup', { meeting: legal.id, content: 'x'.repeat(2 * 1024 * 1024 + 1) });
  ok('save_writeup refuses an oversized write-up', huge.refused && /capped at/.test(huge.text));
  const spared = await fsp
    .stat(path.join(root, 'Meetings', legal.id, 'note.md'))
    .then(() => true)
    .catch(() => false);
  ok('nothing was written when it refused', !spared);
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'min-mcp-smoke-'));
await writeFixture(root);

/*
 * The server resolves the meetings folder from os.homedir() and its index from
 * the platform's app data folder, and neither is a parameter, on purpose: the
 * install manifest promises those two locations and nothing else. Redirecting
 * the environment is therefore the only way to aim it somewhere disposable.
 * os.homedir() reads USERPROFILE on Windows and HOME elsewhere, and the index
 * follows APPDATA or XDG_CONFIG_HOME. The SDK merges this over its own inherited
 * default, so PATH and the rest still reach the child.
 */
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(root, '.config'),
  },
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log('connected\n');
  await run(client, root);
} finally {
  await client.close().catch(() => {});
  // The index is a sqlite file the child had open, and Windows will not unlink
  // one until that process is gone. The retries cover the gap between close()
  // returning here and the OS releasing the handle; without a clean removal the
  // next run inherits a stale index and this stops being repeatable.
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

console.log(failed ? `\n${failed} check(s) failed.` : '\ndone.');
process.exit(failed ? 1 : 0);
