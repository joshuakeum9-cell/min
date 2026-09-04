#!/usr/bin/env node
/**
 * granola-local · MCP server.
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
 * Connect with:
 *   claude mcp add granola-local -- node "<repo>/mcp/server.js"
 * or point any MCP-capable client at this file over stdio.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listMeetings, readMeeting, search, reindex, MEETINGS_DIR } from '../app/library.js';

// The index is a disposable cache and must not live among the user's markdown.
const INDEX_PATH = path.join(os.tmpdir(), 'granola-local-mcp-index.db');

const server = new McpServer({
  name: 'granola-local',
  version: '1.0.0',
});

/** Resolve a meeting by folder name, or by a fuzzy match on the title. */
async function findMeeting(idOrTitle) {
  const all = await listMeetings();
  if (!all.length) throw new Error(`No meetings found in ${MEETINGS_DIR}.`);

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
      'already have a write-up. Use this to find the meeting the user means.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(20).describe('How many to return'),
    },
  },
  async ({ limit }) => {
    const all = await listMeetings();
    if (!all.length) return text(`No meetings yet. They are recorded into ${MEETINGS_DIR}.`);

    const rows = all.slice(0, limit).map((m) => {
      const state = m.written
        ? 'written up'
        : m.transcribed
          ? 'transcribed, no write-up yet'
          : 'not transcribed yet';
      const typed = m.notes.trim() ? `${m.notes.trim().split(/\s+/).length} words of notes` : 'no notes typed';
      return `- ${m.id}\n    "${m.title}" · ${fmtDate(m.startedAt)} · ${fmtDur(m.durationSeconds)} · ${state} · ${typed}`;
    });
    return text(`${all.length} meeting(s) in ${MEETINGS_DIR}:\n\n${rows.join('\n')}`);
  }
);

server.registerTool(
  'read_meeting',
  {
    title: 'Read a meeting',
    description:
      "Read one meeting: the notes the user typed during it, the transcript, and any existing " +
      'write-up. Speakers are labelled "You" (the user) and "Them" (everyone else on the call). ' +
      'Accepts a folder name or part of the title.',
    inputSchema: {
      meeting: z.string().describe('Folder name (e.g. 2026-09-03-1400-vendor-sync) or part of the title'),
      include_transcript: z.boolean().default(true).describe('Set false for just the notes and metadata'),
    },
  },
  async ({ meeting, include_transcript }) => {
    const m = await readMeeting((await findMeeting(meeting)).dir);
    const parts = [
      `# ${m.title}`,
      `${fmtDate(m.startedAt)} · ${fmtDur(m.durationSeconds)} · folder: ${m.id}`,
      '',
      '## Notes the user typed during the meeting',
      m.notes.trim() || '(nothing typed)',
    ];
    if (include_transcript) {
      parts.push('', '## Transcript', m.transcript?.trim() || '(not transcribed yet)');
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
      'Use this to answer questions like "what did we decide about pricing" across many meetings.',
    inputSchema: {
      query: z.string().describe('Words to search for. A trailing * does prefix matching.'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, limit }) => {
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

server.registerTool(
  'save_writeup',
  {
    title: 'Save a write-up',
    description:
      "Save a finished write-up into the meeting's folder as note.md, where the app will show " +
      'it. Call this after writing one up so the user does not have to copy it back by hand. ' +
      'This overwrites any previous write-up for that meeting.',
    inputSchema: {
      meeting: z.string().describe('Folder name or part of the title'),
      content: z.string().min(1).describe('The finished write-up, in markdown'),
    },
  },
  async ({ meeting, content }) => {
    const m = await findMeeting(meeting);
    const clean = content.trim();
    if (!clean) throw new Error('Refusing to save an empty write-up.');

    await fsp.writeFile(path.join(m.dir, 'note.md'), clean + '\n');

    // Record it, but never at the cost of the existing metadata: if meeting.json
    // cannot be read (a lock, a sync client), leave it alone rather than
    // replacing a good record with a stub.
    const metaPath = path.join(m.dir, 'meeting.json');
    try {
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
