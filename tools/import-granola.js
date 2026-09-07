/**
 * MIN · import Granola meetings into the meetings folder.
 *
 *   node tools/import-granola.js --from <staging-dir> [--into <dir>] [--dry-run]
 *
 * The staging directory holds one JSON file per meeting, each:
 *
 *   { "id": "...", "title": "...", "startedAt": "<ISO>",
 *     "participants": ["a@b.com"], "transcript": " Them: Hello.  Me: Hi." }
 *
 * Getting the export out of Granola is deliberately NOT this tool's job, and
 * MIN itself never talks to Granola. The app is local-first and has no account
 * of its own; a one-time move of your own data should not put a cloud service
 * in the middle of it. Whatever can read your Granola (its MCP server, an
 * export) writes those files, and this turns them into meeting folders.
 *
 * Idempotent: a meeting whose id has already been imported is skipped, so
 * running it twice does not give you every meeting twice.
 *
 * All of the format rules live in app/granola-import.js and are under test.
 * This file is the I/O around them, and nothing else.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { toMeetingFolder } from '../app/granola-import.js';
import { loadMeetingsDirFromSettings } from '../app/meetings-dir.js';

// The folder the app is actually pointed at, not the default. Someone who has
// moved their meetings into a synced folder expects an import to land there.
const MEETINGS_DIR = loadMeetingsDirFromSettings();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry-run');
const FROM = arg('--from');
const INTO = path.resolve(arg('--into', MEETINGS_DIR));

if (!FROM) {
  console.error('usage: node tools/import-granola.js --from <staging-dir> [--into <dir>] [--dry-run]');
  process.exit(2);
}

/** Every Granola meeting id already sitting in the meetings folder. */
async function alreadyImported(dir) {
  const seen = new Map();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'meeting.json');
    try {
      const meta = JSON.parse(await fsp.readFile(file, 'utf8'));
      const id = meta?.imported?.meetingId;
      if (id) seen.set(String(id), e.name);
    } catch { /* not an imported meeting, or not readable; either way not a match */ }
  }
  return seen;
}

/** `name`, `name-2`, `name-3`, the same rule main.js uses for a folder clash. */
async function uniqueDir(base) {
  let dir = base;
  for (let n = 2; ; n++) {
    try {
      await fsp.mkdir(dir, { recursive: false });
      return dir;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      dir = `${base}-${n}`;
    }
  }
}

const files = (await fsp.readdir(FROM)).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error(`nothing to import: no .json files in ${FROM}`);
  process.exit(1);
}

const seen = await alreadyImported(INTO);
const importedAt = new Date().toISOString();
let wrote = 0, skipped = 0, empty = 0;

console.log(`${files.length} staged, into ${INTO}${DRY ? '  (dry run, nothing will be written)' : ''}\n`);

for (const file of files) {
  const raw = JSON.parse(await fsp.readFile(path.join(FROM, file), 'utf8'));
  const id = String(raw.id ?? '');

  if (id && seen.has(id)) {
    console.log(`  skip   ${raw.title}\n         already imported as ${seen.get(id)}`);
    skipped++;
    continue;
  }

  const out = toMeetingFolder({
    title: raw.title,
    startedAt: raw.startedAt,
    participants: raw.participants,
    meetingId: id || null,
    transcript: raw.transcript,
  }, { importedAt });

  if (!out.files['transcript.md']) {
    console.log(`  empty  ${raw.title}\n         no turns in the export, nothing written`);
    empty++;
    continue;
  }

  const mins = Math.round(out.seconds / 60);
  console.log(`  ${DRY ? 'would' : 'write'}  ${out.folder}\n         ${out.turns.length} turns, about ${mins} min`);
  if (DRY) { wrote++; continue; }

  await fsp.mkdir(INTO, { recursive: true });
  const dir = await uniqueDir(path.join(INTO, out.folder));
  for (const [name, body] of Object.entries(out.files)) {
    await fsp.writeFile(path.join(dir, name), body, 'utf8');
  }
  if (id) seen.set(id, path.basename(dir));
  wrote++;
}

console.log(`\n${DRY ? 'would write' : 'wrote'} ${wrote}, skipped ${skipped} already there`
  + (empty ? `, ${empty} with no transcript` : ''));
