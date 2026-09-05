/**
 * MIN · the library, listing and full-text search across meetings.
 *
 * The markdown files on disk are the only source of truth. This index is a cache
 * and nothing else: it lives outside the meetings folder, it is rebuilt from the
 * files in about a second, and deleting it loses nothing. That is deliberate ,
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
import { segmentsOf, pendingSegments } from './meeting-schema.js';

export const MEETINGS_DIR = path.join(os.homedir(), 'Meetings');

/* ------------------------------------------------------------------ reading */

/**
 * Per-file ceiling for the text we will pull into the main process. README puts
 * 1,000 hours of transcripts at about 95 MB in total, so a single file of 8 MB is
 * already roughly 80 hours of talking and far outside anything this app writes.
 * Above the ceiling the read is worth avoiding twice over: it buffers the whole
 * file into the main process, and past V8's max string length it throws, which a
 * bare catch would turn into an empty meeting rather than a visible problem.
 */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Read one text file, refusing anything over the ceiling. Returns a status so the
 * caller can tell "not there" (normal, an untranscribed meeting has no
 * transcript.md) from "there but unreadable", which a bare catch collapsed into
 * the same null.
 */
async function readCapped(file) {
  let info;
  try {
    info = await fsp.stat(file);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { text: null, status: 'absent' };
    return { text: null, status: 'unreadable' };
  }
  if (info.size > MAX_TEXT_BYTES) return { text: null, status: 'oversized' };
  try {
    return { text: await fsp.readFile(file, 'utf8'), status: 'ok' };
  } catch {
    return { text: null, status: 'unreadable' };
  }
}

/** Read one meeting folder into a plain object. Missing pieces are nulls, not errors. */
export async function readMeeting(dir) {
  const [metaRes, notesRes, transcriptRes, noteRes] = await Promise.all([
    readCapped(path.join(dir, 'meeting.json')),
    readCapped(path.join(dir, 'my-notes.md')),
    readCapped(path.join(dir, 'transcript.md')),
    readCapped(path.join(dir, 'note.md')),
  ]);

  // Anything the UI should be able to explain instead of rendering as empty.
  const fileIssues = {};
  for (const [field, res] of [
    ['meta', metaRes],
    ['notes', notesRes],
    ['transcript', transcriptRes],
    ['note', noteRes],
  ]) {
    if (res.status !== 'ok' && res.status !== 'absent') fileIssues[field] = res.status;
  }
  const hasIssues = Object.keys(fileIssues).length > 0;

  const metaRaw = metaRes.text;
  const notes = notesRes.text ?? '';
  const transcript = transcriptRes.text;
  const note = noteRes.text;

  // A folder whose meeting.json is missing or corrupt still holds the notes and
  // transcript, which are the stated source of truth. Returning null here made
  // the whole meeting vanish from the list AND from search, hiding the very
  // files the design promises will outlive the app. Degrade instead.
  let meta = null;
  try {
    if (metaRaw) meta = JSON.parse(metaRaw);
  } catch { /* fall through to the reconstructed record */ }

  if (!meta) {
    // A folder we could not read is not the same as an empty folder: dropping it
    // here would hide the problem the same way an empty meeting does.
    if (transcript === null && !notes && note === null && !hasIssues) return null;
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

  /*
   * Any segment's audio counts. A meeting stopped and resumed keeps a wav per
   * capture, and the first segment's mic.wav is deleted as soon as ITS
   * transcript is written, so checking only mic.wav would report a meeting with
   * two hours of untranscribed audio in mic-2.wav as having none at all.
   */
  const wavs = segmentsOf(meta).flatMap((seg) => [seg.files?.mic, seg.files?.system]);
  const sizes = await Promise.all(
    [...new Set(wavs.filter((f) => typeof f === 'string' && f))].map((f) =>
      fsp.stat(path.join(dir, f)).then((st) => st.size).catch(() => 0))
  );
  const hasAudio = sizes.some((n) => n > 44);
  // Audio still on disk that nothing has transcribed. This is what decides
  // whether Write up offers to run the post-recording pass at all.
  const transcriptPending = hasAudio && pendingSegments(meta).length > 0;

  return {
    dir,
    id: path.basename(dir),
    title: meta.title || path.basename(dir),
    startedAt: meta.startedAt ?? null,
    endedAt: meta.endedAt ?? null,
    durationSeconds: meta.durationSeconds ?? 0,
    ...calendarFields(meta),
    notes: notes ?? '',
    transcript,
    note,
    hasAudio,
    transcriptPending,
    transcribed: Boolean(transcript),
    written: Boolean(note),
    meta,
    // Only present when something went wrong, so a healthy record keeps its shape.
    ...(hasIssues ? { fileIssues } : null),
  };
}

/**
 * The calendar event a recording was titled from, as the list needs it. The
 * whole event is kept in meeting.json under "calendarEvent" (see save-meeting);
 * the rows only want who was there and which event it was.
 */
function calendarFields(meta) {
  const ev = meta?.calendarEvent;
  if (!ev || typeof ev !== 'object') return { attendees: [], calendarUid: null, recurring: false };
  const attendees = Array.isArray(ev.attendees)
    ? ev.attendees.filter((a) => typeof a === 'string' && a.trim()).slice(0, 50)
    : [];
  return {
    attendees,
    calendarUid: typeof ev.uid === 'string' && ev.uid ? ev.uid : null,
    recurring: Boolean(ev.recurring),
  };
}

async function meetingDirs() {
  const entries = await fsp.readdir(MEETINGS_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(MEETINGS_DIR, e.name))
    .sort()
    .reverse(); // newest first, the one you want is almost always the last one
}

/** Every meeting with its bodies. This is what the index is built from. */
export async function listMeetings() {
  const out = [];
  for (const d of await meetingDirs()) {
    const m = await readMeeting(d);
    if (m) out.push(m);
  }
  return out;
}

const exists = (file) => fsp.stat(file).then(() => true).catch(() => false);
const sizeOf = (file) => fsp.stat(file).then((s) => s.size).catch(() => 0);

/**
 * One meeting for the home list: meeting.json plus a stat of each file, and no
 * markdown read at all. Listing used to go through readMeeting, which pulled
 * every transcript in the library into memory to draw a list of titles.
 *
 * Degrades the same way readMeeting does: a missing or corrupt meeting.json is
 * reconstructed from the folder name, and a folder with nothing in it is null.
 */
/**
 * Does this meeting still have audio on disk?
 *
 * mic.wav answers it for a meeting that was never resumed, and that stat has
 * already been paid for by the time this is called. Only a resumed meeting
 * whose first segment's audio has already been deleted needs the extra look, so
 * the fast path stays one stat for the case that is almost always true.
 */
async function anyAudio(dir, meta, micBytes) {
  if (micBytes > 44) return true;
  const later = segmentsOf(meta)
    .flatMap((seg) => [seg.files?.mic, seg.files?.system])
    .filter((f) => typeof f === 'string' && f && f !== 'mic.wav');
  if (!later.length) return false;
  const sizes = await Promise.all([...new Set(later)].map((f) => sizeOf(path.join(dir, f))));
  return sizes.some((n) => n > 44);
}

export async function summariseMeeting(dir) {
  const [metaRes, hasTranscript, hasNote, notesBytes, micBytes] = await Promise.all([
    readCapped(path.join(dir, 'meeting.json')),
    exists(path.join(dir, 'transcript.md')),
    exists(path.join(dir, 'note.md')),
    sizeOf(path.join(dir, 'my-notes.md')),
    sizeOf(path.join(dir, 'mic.wav')),
  ]);

  let meta = null;
  try {
    if (metaRes.text) meta = JSON.parse(metaRes.text);
  } catch { /* fall through to the reconstructed record */ }

  if (!meta) {
    // The empty-notes file the recorder always writes is one newline, so a
    // folder is empty when nothing is bigger than that.
    if (!hasTranscript && !hasNote && notesBytes <= 1 && metaRes.status === 'absent') return null;
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

  return {
    dir,
    id: path.basename(dir),
    title: meta.title || path.basename(dir),
    startedAt: meta.startedAt ?? null,
    endedAt: meta.endedAt ?? null,
    durationSeconds: meta.durationSeconds ?? 0,
    ...calendarFields(meta),
    // Bytes, not characters: the point is "did they type anything", and a
    // count that needs the file read defeats the purpose of this function.
    notesBytes: Math.max(0, notesBytes - 1),
    hasAudio: await anyAudio(dir, meta, micBytes),
    transcriptPending: pendingSegments(meta).length > 0,
    transcribed: hasTranscript,
    written: hasNote,
    metaBroken: Boolean(meta.metaBroken),
  };
}

/** Every meeting, newest first, without reading a single markdown file. */
export async function listSummaries() {
  const out = [];
  for (const d of await meetingDirs()) {
    const m = await summariseMeeting(d);
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

  // The ceiling is repeated here because the rebuild runs inside one transaction:
  // a single oversized value would abort the whole index, not just its own row.
  // Dropped rather than truncated, so half a document cannot pass for a whole one.
  const capped = (t) => ((t ?? '').length > MAX_TEXT_BYTES ? '' : t);

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
      insert.run(
        m.id,
        m.dir,
        clean(capped(m.title)),
        clean(capped(m.notes)),
        clean(capped(m.transcript)),
        clean(capped(m.note))
      );
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
