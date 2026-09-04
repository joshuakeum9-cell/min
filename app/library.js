/**
 * Taonim · the library — listing and full-text search across meetings.
 *
 * The markdown files on disk are the only source of truth. This index is a cache
 * and nothing else: it lives outside the meetings folder, it is rebuilt from the
 * files in about a second, and deleting it loses nothing. That is deliberate —
 * it means the index needs no backup story, no migration story, and no crash
 * recovery, and it can never disagree with the files for long.
 *
 * Uses node:sqlite, built into Node 24, so there is no native module to compile
 * and no prebuild matrix to maintain.
 *
 * Note on FTS5: a contentless index (content='') would be roughly 40% smaller,
 * but it cannot return text, which rules out search snippets. For a personal tool
 * holding hundreds of meetings the difference is tens of megabytes, and snippets
 * are worth far more than that.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const MEETINGS_DIR = path.join(os.homedir(), 'Meetings');

/* ------------------------------------------------------------------ reading */

/** Read one meeting folder into a plain object. Missing pieces are nulls, not errors. */
export async function readMeeting(dir) {
  const [metaRaw, notes, transcript, note] = await Promise.all([
    fsp.readFile(path.join(dir, 'meeting.json'), 'utf8').catch(() => null),
    fsp.readFile(path.join(dir, 'my-notes.md'), 'utf8').catch(() => ''),
    fsp.readFile(path.join(dir, 'transcript.md'), 'utf8').catch(() => null),
    fsp.readFile(path.join(dir, 'note.md'), 'utf8').catch(() => null),
  ]);
  // A folder whose meeting.json is missing or corrupt still holds the notes and
  // transcript, which are the stated source of truth. Returning null here made
  // the whole meeting vanish from the list AND from search — hiding the very
  // files the design promises will outlive the app. Degrade instead.
  let meta = null;
  try {
    if (metaRaw) meta = JSON.parse(metaRaw);
  } catch { /* fall through to the reconstructed record */ }

  if (!meta) {
    if (transcript === null && !notes && note === null) return null;
    const stamp = path.basename(dir).match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(.*)$/);
    meta = {
      title: stamp ? stamp[6].replace(/-/g, ' ') : path.basename(dir),
      startedAt: stamp
        ? new Date(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5]).toISOString()
        : null,
      durationSeconds: 0,
      metaBroken: true,
    };
  }

  const hasAudio = await fsp
    .stat(path.join(dir, 'mic.wav'))
    .then((s) => s.size > 44)
    .catch(() => false);

  return {
    dir,
    id: path.basename(dir),
    title: meta.title || path.basename(dir),
    startedAt: meta.startedAt ?? null,
    durationSeconds: meta.durationSeconds ?? 0,
    notes: notes ?? '',
    transcript,
    note,
    hasAudio,
    transcribed: Boolean(transcript),
    written: Boolean(note),
    meta,
  };
}

export async function listMeetings() {
  const entries = await fsp.readdir(MEETINGS_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(MEETINGS_DIR, e.name))
    .sort()
    .reverse(); // newest first — the one you want is almost always the last one

  const out = [];
  for (const d of dirs) {
    const m = await readMeeting(d);
    if (m) out.push(m);
  }
  return out;
}

/* -------------------------------------------------------------------- index */

let db = null;

export function openIndex(dbPath) {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      id UNINDEXED,
      dir UNINDEXED,
      title,
      notes,
      transcript,
      note,
      tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

/** Rebuild from disk. Cheap enough that it is the only update path worth having. */
export async function reindex(dbPath) {
  const d = openIndex(dbPath);
  const meetings = await listMeetings();

  // U+0001/U+0002 mark snippet boundaries, so strip any that occur naturally.
  const clean = (t) => (t ?? '').replaceAll('\u0001', '').replaceAll('\u0002', '');

  // Without an explicit transaction node:sqlite commits per row, which means a
  // disk sync per meeting on the main thread.
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM docs');
    const insert = d.prepare(
      'INSERT INTO docs (id, dir, title, notes, transcript, note) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const m of meetings) {
      insert.run(m.id, m.dir, clean(m.title), clean(m.notes), clean(m.transcript), clean(m.note));
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  d.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(
    'indexedAt',
    new Date().toISOString()
  );
  return meetings.length;
}

/**
 * FTS5 treats a bare user string as query syntax, so an unbalanced quote or a
 * stray AND throws. Quote each term instead and let the user opt into operators
 * only through a trailing `*` for prefix search.
 */
function toMatchQuery(q) {
  const terms = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const prefix = t.endsWith('*');
      const bare = t.replace(/\*+$/, '').replace(/"/g, '');
      return bare ? `"${bare}"${prefix ? '*' : ''}` : null;
    })
    .filter(Boolean);
  return terms.join(' AND ');
}

export function search(dbPath, q, limit = 50) {
  if (!q || !q.trim()) return [];
  const d = openIndex(dbPath);
  const match = toMatchQuery(q);
  if (!match) return [];

  try {
    return d
      .prepare(
        `SELECT id, dir, title,
                snippet(docs, 3, char(1), char(2), '...', 12) AS notesHit,
                snippet(docs, 4, char(1), char(2), '...', 12) AS transcriptHit,
                snippet(docs, 5, char(1), char(2), '...', 12) AS noteHit,
                bm25(docs, 0, 0, 10.0, 5.0, 1.0, 3.0) AS score
           FROM docs
          WHERE docs MATCH ?
       ORDER BY score
          LIMIT ?`
      )
      .all(match, limit);
  } catch (err) {
    // A malformed query is a user typing, not a fault worth throwing over.
    return [];
  }
}

export function closeIndex() {
  db?.close();
  db = null;
}
