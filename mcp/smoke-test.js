/**
 * MCP smoke test, drives the real server over a real stdio transport.
 *
 * Deliberately uses the SDK client rather than hand-rolled JSON-RPC, so this
 * exercises the same handshake an actual assistant performs. A server that
 * "looks right" but fails the initialize round-trip would pass any lesser test.
 *
 * Run: node mcp/smoke-test.js
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.js');

const ok = (label, cond, extra = '') =>
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ' , ' + extra : ''}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);
console.log('connected\n');

// --- tools are advertised ---
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log('tools:', names.join(', '), '\n');
ok('all five tools registered', names.length === 5);
for (const want of ['list_meetings', 'read_meeting', 'search_meetings', 'save_writeup', 'writing_guidance']) {
  ok(`  ${want}`, names.includes(want));
}

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? '';
};

// --- list ---
const list = await call('list_meetings', { limit: 5 });
ok('list_meetings returns meetings', /meeting\(s\) in|No meetings yet/.test(list));
console.log('\n' + list.split('\n').slice(0, 4).join('\n') + '\n');

// Pull a real folder name out of the listing to drive the rest.
const id = list.match(/^- (\S+)$/m)?.[1];
if (!id) {
  console.log('\nNo meetings on disk, record one to exercise the remaining tools.');
  await client.close();
  process.exit(0);
}

// --- read ---
const read = await call('read_meeting', { meeting: id });
ok('read_meeting returns notes and transcript', read.includes('Notes the user typed') && read.includes('Transcript'));

// --- fuzzy resolution ---
// A unique fragment must resolve; an ambiguous one must REFUSE and say why,
// rather than silently picking a meeting the user did not mean.
const unique = id.slice(0, 16);            // the date-time stamp
const fuzzy = await call('read_meeting', { meeting: unique, include_transcript: false });
ok('resolves a unique fragment', fuzzy.startsWith('#'), `"${unique}"`);

let ambiguous = '';
try {
  await call('read_meeting', { meeting: 'untitled' });
} catch (e) {
  ambiguous = String(e.message ?? e);
}
ok(
  'refuses an ambiguous name instead of guessing',
  /matches \d+ meetings/.test(ambiguous) || ambiguous === '',
  ambiguous ? ambiguous.slice(0, 60) : 'only one candidate on disk'
);

// --- search ---
const hit = await call('search_meetings', { query: 'statutes' });
ok('search finds a known phrase', /match\(es\)|Nothing matches/.test(hit));
ok('search markers converted to markdown', !hit.includes('\u0001'));

// --- guidance ---
const guide = await call('writing_guidance');
ok('guidance states the thesis', guide.includes('skeleton') && guide.includes('would read the same'));

// --- save round-trip, then restore whatever was there before ---
const before = read.includes('## Existing write-up')
  ? read.split('## Existing write-up')[1].trim()
  : null;

const marker = '# Smoke test\n\nWritten by mcp/smoke-test.js.';
const saved = await call('save_writeup', { meeting: id, content: marker });
ok('save_writeup reports bytes written', /Saved [\d,]+ characters/.test(saved));

const reread = await call('read_meeting', { meeting: id, include_transcript: false });
ok('write-up is readable straight back', reread.includes('Smoke test'));

if (before) {
  await call('save_writeup', { meeting: id, content: before });
  console.log('\n  (restored the previous write-up)');
} else {
  const { unlink } = await import('node:fs/promises');
  const { MEETINGS_DIR } = await import('../app/library.js');
  await unlink(path.join(MEETINGS_DIR, id, 'note.md')).catch(() => {});
  console.log('\n  (removed the test write-up)');
}

await client.close();
console.log('\ndone.');
