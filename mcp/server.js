#!/usr/bin/env node
/**
 * MIN · MCP server.
 *
 * Lets an assistant read your meetings straight off disk instead of you pasting
 * a transcript into a chat box. Once connected you can just say:
 *
 *   "Write up my 3pm call with the vendor."
 *
 * and it reads your notes and the transcript, writes the note back into the
 * meeting folder, and you never touch the clipboard.
 *
 * This is the honest version of "connect the app to my AI account". The app
 * still never sees a credential: the assistant runs this process locally, under
 * the user's own subscription, over stdin/stdout. Nothing is uploaded, no key
 * exists, and nothing is exposed to the network.
 *
 * It touches two places on disk: the Meetings folder, which it reads and writes,
 * and MIN's own application data folder, where it keeps the search index. The
 * one other write is deleting the index an earlier build left in the OS temp
 * directory. The manifest shown at install time says exactly this, and it is the
 * only thing most people read before granting an extension access to their
 * files, so the two have to stay true together.
 *
 * Connect with:
 *   claude mcp add MIN -- node "<repo>/mcp/server.js"
 * or point any MCP-capable client at this file over stdio.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listMeetings, readMeeting, search, reindex, meetingsDir } from '../app/library.js';
import { loadMeetingsDirFromSettings } from '../app/meetings-dir.js';

/*
 * This server runs under plain node inside Claude Desktop, with no Electron
 * `app` to ask and no environment from MIN. If the user has pointed MIN at
 * another folder (a synced Drive folder, say), reading the default would have
 * it answering questions about an empty directory while the real one fills up.
 * So it reads MIN's own settings file, the same way MIN does.
 */
loadMeetingsDirFromSettings();

/**
 * Where Electron puts userData for this app, worked out without Electron: this
 * process runs under the host's own Node runtime, so app.getPath does not exist
 * here. Keeping the same folder means everything MIN leaves on disk outside
 * the Meetings folder is in one place, under the app's name, where a user can
 * find it and delete it.
 */
function appDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'MIN');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'MIN');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'MIN');
}

// The index holds the plaintext of every note, transcript and write-up, so it
// belongs with the app's own data: not among the user's markdown, where it would
// end up in their Dropbox, and not in os.tmpdir(), which on a shared machine is
// readable by other accounts and is swept by cleaners that know nothing about
// it. Separate file from the app's own index.db so the two processes never
// rebuild the same database at the same time.
const INDEX_PATH = path.join(appDataDir(), 'mcp-index.db');

const server = new McpServer({
  name: 'MIN',
  version: '1.0.0',
});

/* -------------------------------------------------------------- containment */

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * True when `target` is the meetings root or sits under it.
 *
 * The trailing separator is the whole point of the test: a bare prefix check
 * also accepts "~/Meetings-old" and "~/Meetings.bak". Windows compares
 * case-folded because NTFS opens "meetings\x" and "Meetings\X" as one file.
 *
 * This is a name test only, it does not follow links. Anything about to be
 * written goes through writableInMeetings below, which does.
 */
function insideMeetings(target, root = meetingsDir()) {
  const r = fold(path.resolve(root));
  const t = fold(path.resolve(target));
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Containment for a path about to be written, with links resolved first: a
 * note.md that is a symlink to ~/.ssh/authorized_keys sits inside the meetings
 * folder by name and writes outside it in fact. A file that does not exist yet
 * is checked through its parent directory, which does. Resolve the root too, in
 * case the user's Meetings folder is itself a link onto another drive.
 *
 * This is deliberately stricter than confine() in app/main.js, which stops at
 * path.resolve and so lets a planted symlink or junction through. The asymmetry
 * is about who is calling. There the caller is the app's own renderer running
 * code we shipped, and planting a link inside the folder already needs write
 * access to the user's disk. Here the caller is whatever MCP client the user
 * connected, driven by a model reading meeting text other people wrote, which
 * makes save_writeup the least trusted write path in the product. It pays for
 * the extra realpath calls. Do not unify the two gates by weakening this one.
 */
async function writableInMeetings(target) {
  const real = await fsp.realpath(target).catch(async () => {
    const dir = await fsp.realpath(path.dirname(target)).catch(() => path.dirname(target));
    return path.join(dir, path.basename(target));
  });
  const root = await fsp.realpath(meetingsDir()).catch(() => meetingsDir());
  if (!insideMeetings(real, root)) {
    throw new Error(
      `Refusing to write ${path.basename(target)}: it resolves outside ${meetingsDir()}.`
    );
  }
  return real;
}

/** Resolve a meeting the caller named, and refuse anything outside the folder. */
async function findMeeting(idOrTitle) {
  const m = await matchMeeting(idOrTitle);
  // Nothing reachable today fails this: every id is a directory name read out of
  // the meetings folder, so a caller passing "../../etc" matches nothing. It is
  // the choke point every path-taking tool goes through, so it stays, and a
  // later change that does join caller input onto a path cannot silently turn
  // these five tools into a read and write primitive for the whole disk.
  if (!insideMeetings(m.dir)) {
    throw new Error(`Refusing "${idOrTitle}": it resolves outside ${meetingsDir()}.`);
  }
  return m;
}

/** Match by exact folder name first, then by a fuzzy match on the title. */
async function matchMeeting(idOrTitle) {
  const all = await listMeetings();
  if (!all.length) throw new Error(`No meetings found in ${meetingsDir()}.`);

  const needle = idOrTitle.trim().toLowerCase();
  const exact = all.find((m) => m.id.toLowerCase() === needle);
  if (exact) return exact;

  const byTitle = all.filter((m) => m.title.toLowerCase().includes(needle));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new Error(
      `"${idOrTitle}" matches ${byTitle.length} meetings: ` +
        byTitle.map((m) => m.id).join(', ') +
        `. Use the exact folder name.`
    );
  }
  const byId = all.filter((m) => m.id.toLowerCase().includes(needle));
  if (byId.length === 1) return byId[0];
  throw new Error(`No meeting matches "${idOrTitle}". Use list_meetings to see what exists.`);
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : 'unknown date');
const fmtDur = (s) => (s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)}s`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

/* -------------------------------------------------------------------- tools */

server.registerTool(
  'list_meetings',
  {
    title: 'List meetings',
    description:
      'List recorded meetings, newest first. Shows which have been transcribed and which ' +
      'already have a write-up. A meeting being recorded at this moment is listed as ' +
      '"recording now": its transcript grows while you read it. Use this to find the meeting ' +
      'the user means.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(20).describe('How many to return'),
    },
  },
  async ({ limit }) => {
    const all = await listMeetings();
    if (!all.length) return text(`No meetings yet. They are recorded into ${meetingsDir()}.`);

    const rows = all.slice(0, limit).map((m) => {
      const state = m.recording
        ? 'recording now'
        : m.written
          ? 'written up'
          : m.transcribed
            ? 'transcribed, no write-up yet'
            : 'not transcribed yet';
      const length = m.recording ? 'in progress' : fmtDur(m.durationSeconds);
      const typed = m.notes.trim() ? `${m.notes.trim().split(/\s+/).length} words of notes` : 'no notes typed';
      return `- ${m.id}\n    "${m.title}" · ${fmtDate(m.startedAt)} · ${length} · ${state} · ${typed}`;
    });
    return text(`${all.length} meeting(s) in ${meetingsDir()}:\n\n${rows.join('\n')}`);
  }
);

server.registerTool(
  'read_meeting',
  {
    title: 'Read a meeting',
    description:
      "Read one meeting: the notes the user typed during it, the transcript, and any existing " +
      'write-up. Speakers are labelled "You" (the user) and "Them" (everyone else on the call). ' +
      'If the meeting is being recorded right now, the transcript is what has been said so far ' +
      'and the notes are what has been typed so far; call again to get the newer lines. ' +
      'Accepts a folder name or part of the title.',
    inputSchema: {
      // min(1) because an empty needle substring-matches every meeting: with one
      // meeting on disk that silently resolves to it rather than erroring.
      meeting: z.string().min(1).describe('Folder name (e.g. 2026-09-03-1400-vendor-sync) or part of the title'),
      include_transcript: z.boolean().default(true).describe('Set false for just the notes and metadata'),
    },
  },
  async ({ meeting, include_transcript }) => {
    const m = await readMeeting((await findMeeting(meeting)).dir);
    const parts = [
      `# ${m.title}`,
      `${fmtDate(m.startedAt)} · ${m.recording ? 'recording now, still in progress' : fmtDur(m.durationSeconds)} · folder: ${m.id}`,
      '',
      m.recording ? '## Notes the user has typed so far' : '## Notes the user typed during the meeting',
      m.notes.trim() || '(nothing typed)',
    ];
    if (include_transcript) {
      parts.push(
        '',
        m.recording ? '## Transcript so far (still recording; read again for newer lines)' : '## Transcript',
        m.transcript?.trim() || (m.recording ? '(nothing said yet)' : '(not transcribed yet)'),
      );
    }
    if (m.note) parts.push('', '## Existing write-up', m.note.trim());
    return text(parts.join('\n'));
  }
);

server.registerTool(
  'search_meetings',
  {
    title: 'Search meetings',
    description:
      'Full-text search across every meeting: the notes, the transcripts and the write-ups. ' +
      'Use this to answer questions like "what did we decide about pricing" across many meetings. ' +
      "Builds a local index of that text in MIN's own app data folder, and refreshes it on " +
      'each search.',
    inputSchema: {
      query: z.string().describe('Words to search for. A trailing * does prefix matching.'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
    // First search after a fresh install: the app may never have run, so its
    // data folder does not exist yet and opening the database would fail.
    await fsp.mkdir(path.dirname(INDEX_PATH), { recursive: true });
    await reindex(INDEX_PATH);
    const hits = search(INDEX_PATH, query, limit);
    if (!hits.length) return text(`Nothing matches "${query}".`);

    const strip = (s) => (s ?? '').replaceAll('\u0001', '**').replaceAll('\u0002', '**');
    const rows = hits.map((h) => {
      const best = [h.notesHit, h.noteHit, h.transcriptHit].find((x) => x && x.includes('\u0001'));
      return `- ${h.id} · "${h.title}"\n    ${strip(best) || '(matched the title)'}`;
    });
    return text(`${hits.length} match(es) for "${query}":\n\n${rows.join('\n')}`);
  }
);

/**
 * Upper bound on a saved write-up. A long one is a few kilobytes, so this sits
 * three orders of magnitude clear of any real note and can only ever catch a
 * client that has gone wrong: a runaway generation, or a model talked by meeting
 * text into dumping something large into the user's folder. Bounded because this
 * is the one write an outside AI client drives, and an unbounded one is a way to
 * fill a disk without ever tripping the containment check.
 */
const MAX_WRITEUP_BYTES = 2 * 1024 * 1024;

server.registerTool(
  'save_writeup',
  {
    title: 'Save a write-up',
    description:
      "Save a finished write-up into the meeting's folder as note.md, where the app will show " +
      'it. Call this after writing one up so the user does not have to copy it back by hand. ' +
      'This overwrites any previous write-up for that meeting.',
    inputSchema: {
      meeting: z.string().min(1).describe('Folder name or part of the title'),
      content: z.string().min(1).describe('The finished write-up, in markdown'),
    },
  },
  async ({ meeting, content }) => {
    const m = await findMeeting(meeting);
    const clean = content.trim();
    if (!clean) throw new Error('Refusing to save an empty write-up.');

    const bytes = Buffer.byteLength(clean, 'utf8');
    if (bytes > MAX_WRITEUP_BYTES) {
      throw new Error(
        `Refusing to save ${bytes.toLocaleString()} bytes to ${m.id}/note.md: write-ups are ` +
          `capped at ${MAX_WRITEUP_BYTES.toLocaleString()} bytes. A meeting write-up is a few ` +
          `kilobytes, so something has gone wrong upstream. Nothing was written.`
      );
    }

    await fsp.writeFile(await writableInMeetings(path.join(m.dir, 'note.md')), clean + '\n');

    // Record it, but never at the cost of the existing metadata: if meeting.json
    // cannot be read (a lock, a sync client, or a link pointing out of the
    // meetings folder), leave it alone rather than replacing a good record with
    // a stub.
    try {
      const metaPath = await writableInMeetings(path.join(m.dir, 'meeting.json'));
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      meta.note = { at: new Date().toISOString(), chars: clean.length, source: 'mcp' };
      await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
    } catch {
      /* note.md is written either way, and it is the thing that matters */
    }

    return text(`Saved ${clean.length.toLocaleString()} characters to ${m.id}/note.md.`);
  }
);

server.registerTool(
  'writing_guidance',
  {
    title: 'How to write these up',
    description:
      'Read this BEFORE writing up a meeting. Explains how the user wants their notes ' +
      'enhanced rather than summarised.',
    inputSchema: {},
  },
  async () =>
    text(
      `The user's own notes are the skeleton. You are filling them in, not summarising the call.\n\n` +
        `1. Keep their headings, keep their order, keep their wording wherever it already says what they meant.\n` +
        `2. Use the transcript only to fill in what they abbreviated or missed under each heading.\n` +
        `3. Add nothing that is not in the transcript. No invented names, numbers, dates, owners or commitments.\n` +
        `4. Do not turn proposals into decisions. If something was floated but not agreed, say it was floated.\n` +
        `5. Keep their voice. "I don't buy the timeline" must not become "concerns were raised regarding timeline feasibility."\n` +
        `6. Where they left a question mark, either answer it from the transcript or leave it open. Do not quietly drop it.\n` +
        `7. Anything important that fits none of their headings goes at the end under "Not in my notes", so they can see which parts are yours.\n\n` +
        `The test that matters: if the write-up would read the same had they typed nothing, it has failed.\n\n` +
        `When you are done, call save_writeup so it lands in the meeting folder.`
    )
);

/* --------------------------------------------------------------------- run */

const transport = new StdioServerTransport();
await server.connect(transport);
