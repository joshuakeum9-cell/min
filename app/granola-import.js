/**
 * MIN . turning a Granola export into a MIN meeting folder.
 *
 * Granola hands back one string per meeting, speaker turns run together and
 * separated by two spaces:
 *
 *   " Them: Hello.  Me: Hi, can you hear me?  Them: Morning, how are you?"
 *
 * MIN's transcript.md is one line per turn, stamped:
 *
 *   [00:00:00] Them: Hello.
 *   [00:00:01] You: Hi, can you hear me?
 *
 * THE ONE THING TO KNOW ABOUT THIS FILE: a Granola export carries no times.
 * Not a start per turn, not a duration, nothing. MIN's reader
 * (`conversation.js`) needs a stamp on every line, and `renderBubbles` SORTS by
 * it, so a file of zeroes would not merely lose the clock, it would reorder the
 * conversation into "everything you said, then everything they said". The
 * stamps this module writes are therefore ESTIMATED from word position, at
 * MIN's own pace constant, and every record it writes says so in three places:
 * `imported.timestamps` in meeting.json, a header line in transcript.md, and
 * `transcript.source`. They are a reading position, not a record of when a
 * thing was said, and nothing downstream should treat them as measured.
 *
 * Pure: no imports, no I/O, no clock of its own. tools/import-granola.js does
 * the file writing, and every rule below is under test in granola-import.test.js.
 */

/**
 * Seconds per spoken word, MIN's own constant from conversation.js:172, where
 * it estimates the end of a transcript line from its length. Reusing it rather
 * than picking a second number keeps an imported meeting paced like a recorded
 * one, which matters because the same reader lays out both.
 */
export const SECONDS_PER_WORD = 0.4;

/**
 * A speaker label at the start of a turn. Granola writes `Me` for the person
 * whose Granola it is, `Them` for an unidentified other, or a participant's
 * name. A turn boundary is two or more spaces, or the start of the string,
 * so a colon inside speech ("so the deal is: we ship") cannot open a new turn
 * unless it is also preceded by a double space and a capitalised word.
 *
 * The leading `^\s*` and not a bare `^`: a real Granola export opens with ONE
 * space before the first label. Anchored on `^` alone that first label went
 * unmatched, and the opening turn came out as the literal text "Them: Hello."
 * attributed to Them. It read almost right, and was wrong in the text, in the
 * word count, and on the page.
 *
 * Names are allowed up to four capitalised words, which covers "Casey Nolan"
 * and "Dana R. Whitfield" without swallowing a sentence.
 */
const TURN = /(?:^\s*|\s{2,})(Me|Them|[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3}):[ \t]/g;

/** hh:mm:ss, hours never truncated, matching transcribe.js and conversation.js. */
export function hhmmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function words(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).length;
}

/**
 * Split a Granola transcript string into turns.
 *
 * Returns `[{ speaker: 'You' | 'Them', name: string | null, text }]` in the
 * order spoken. `Me` becomes `You`, because that is what MIN calls the
 * microphone track and what its line reader accepts. Anyone else becomes
 * `Them`; a NAMED speaker keeps their name in `name`, since MIN's format has
 * only the two labels and the name would otherwise be dropped on the floor.
 *
 * Text before the first label is not silently lost: it becomes an opening
 * `Them` turn, on the grounds that an unattributed line in a meeting is far
 * more likely to be someone else than to be you.
 */
export function parseGranolaTranscript(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, ' ');
  const turns = [];
  const marks = [];
  TURN.lastIndex = 0;
  for (let m = TURN.exec(text); m; m = TURN.exec(text)) {
    marks.push({ label: m[1], from: m.index, to: TURN.lastIndex });
  }

  const push = (label, body) => {
    const clean = String(body ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) return;
    const named = label !== 'Me' && label !== 'Them' ? label : null;
    turns.push({ speaker: label === 'Me' ? 'You' : 'Them', name: named, text: clean });
  };

  if (!marks.length) {
    push('Them', text);
    return turns;
  }
  // Anything ahead of the first label is a turn nobody labelled.
  push('Them', text.slice(0, marks[0].from));
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].from : text.length;
    push(marks[i].label, text.slice(marks[i].to, end));
  }
  return turns;
}

/**
 * How many words a single transcript line may carry before it is broken up.
 *
 * About 55 words is twenty-odd seconds of speech, which is the size of line a
 * MIN recording produces naturally: its voice-activity detector cuts at pauses,
 * so nothing it writes is ever a wall of text.
 */
export const MAX_WORDS_PER_LINE = 55;

/**
 * Break very long turns into paragraph-sized lines at sentence boundaries.
 *
 * Why this is needed: a Granola export of a webinar can carry ten thousand
 * characters under a single "Them:" label, because one person talked for ten
 * minutes and nothing interrupted them. Written straight out, that is one line
 * of transcript.md ten thousand characters wide. It wraps badly in every text
 * viewer, it makes a useless search snippet, and an assistant retrieving the
 * file gets one undifferentiated block instead of passages.
 *
 * Nothing is reworded, reordered or dropped: the split happens BETWEEN
 * sentences, so every word survives in the order it was said, and the speaker
 * is carried onto each piece. A single sentence longer than the limit is left
 * whole rather than cut in half, because a sentence chopped mid-clause reads
 * like a transcription error and this file is meant to be quotable.
 *
 * In the app these pieces merge back into one bubble, which is right: the
 * person really did speak without stopping. The gain is in the file.
 */
export function splitLongTurns(turns, opts = {}) {
  const max = Number(opts.maxWords) > 0 ? Number(opts.maxWords) : MAX_WORDS_PER_LINE;
  const out = [];
  for (const turn of turns) {
    if (words(turn.text) <= max) { out.push(turn); continue; }
    // Keep the terminator with its sentence: split after . ! or ? plus a space.
    const sentences = String(turn.text).split(/(?<=[.!?])\s+/).filter(Boolean);
    let buffer = [];
    let count = 0;
    const flush = () => {
      if (!buffer.length) return;
      out.push({ ...turn, text: buffer.join(' ') });
      buffer = [];
      count = 0;
    };
    for (const sentence of sentences) {
      const n = words(sentence);
      // Adding this sentence would overflow a line that already has something
      // in it, so close that line first. A lone oversized sentence still goes
      // out whole, on its own line.
      if (count && count + n > max) flush();
      buffer.push(sentence);
      count += n;
      if (count >= max) flush();
    }
    flush();
  }
  return out;
}

/**
 * Give each turn a start time by counting the words before it.
 *
 * Estimated, and only defensible because it is disclosed everywhere it lands.
 * Two properties are worth having even from an estimate: the stamps are
 * strictly non-decreasing, so `renderBubbles` keeps the conversation in the
 * order it was spoken, and the last one is a sane guess at the meeting's
 * length rather than a zero that would read as "no meeting here".
 */
export function estimateTimeline(turns, opts = {}) {
  const rate = Number(opts.secondsPerWord) > 0 ? Number(opts.secondsPerWord) : SECONDS_PER_WORD;
  let spoken = 0;
  const out = turns.map((t) => {
    const at = { ...t, t0: +(spoken * rate).toFixed(2) };
    spoken += words(t.text);
    return at;
  });
  return { turns: out, seconds: +(spoken * rate).toFixed(2) };
}

/**
 * The transcript.md body.
 *
 * The header is a bare line with no stamp. That is deliberate and load-bearing:
 * `segmentsFromTranscript` folds an unstamped line into the line above it, and
 * with no line above, drops it. So the note the reader sees at the top of the
 * file cannot leak into the first bubble.
 */
export function toTranscriptMd(turns, opts = {}) {
  const lines = turns.map((t) => {
    const said = t.name ? `${t.name}: ${t.text}` : t.text;
    return `[${hhmmss(t.t0)}] ${t.speaker}: ${said}`;
  });
  // No turns, no file. A header on its own would be a transcript.md that makes
  // `transcribed` true for a meeting that holds nothing.
  if (!lines.length) return '';
  const header = opts.header === false
    ? []
    : ['Imported from Granola. Times are estimated from word count, not recorded.', ''];
  return [...header, ...lines].join('\n') + '\n';
}

/** MIN's folder rule, from main.js:292. Same stamp, same 48-character slug. */
export function folderNameFor(startedAt, title) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    : '0000-00-00-0000';
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
  return `${stamp}-${slug}`;
}

/**
 * The meeting.json for an imported meeting.
 *
 * `schema: 2` with an EMPTY segments array is the honest description and also
 * the safe one. `segmentsOf` returns it verbatim rather than synthesising a
 * legacy segment, so `hasAudio` is false and `transcriptPending` is false: the
 * app will never offer to transcribe audio that was never captured, and never
 * hunt for a mic.wav that does not exist.
 *
 * Participants ride in `calendarEvent.attendees`, which is the field the note
 * header already reads for its "N attendees" chip. `uid` stays null because
 * this did not come from the calendar feed.
 */
export function meetingRecord(input, opts = {}) {
  const { title, startedAt, participants = [], meetingId = null } = input;
  const seconds = Number(opts.seconds) || 0;
  const importedAt = opts.importedAt ?? null;
  const people = (Array.isArray(participants) ? participants : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .slice(0, 50);

  return {
    schema: 2,
    title: String(title ?? '').trim() || 'Untitled',
    startedAt: startedAt ?? null,
    endedAt: null,
    durationSeconds: seconds,
    // Estimated like the stamps it was derived from, and labelled as such below.
    spanSeconds: seconds,
    segments: [],
    tracks: {},
    timeline: { deviceEvents: [] },
    calendarEvent: people.length ? { attendees: people, uid: null, recurring: false } : null,
    audioDisposition: 'none: imported, no audio was ever captured by MIN',
    transcript: {
      source: 'granola-import',
      complete: true,
      count: Number(opts.count) || 0,
      timestamps: 'estimated',
    },
    imported: {
      app: 'Granola',
      meetingId,
      importedAt,
      timestamps: 'estimated from word count at ' + SECONDS_PER_WORD + 's per word',
      note: 'Granola exports carry no per-line times. The stamps in transcript.md '
        + 'order the conversation and approximate its length; they are not a record '
        + 'of when anything was said.',
    },
  };
}

/**
 * One Granola meeting to the files MIN wants, as data. The caller writes them.
 * Returns `{ folder, files: { 'meeting.json': string, 'transcript.md': string,
 * 'my-notes.md': string }, turns, seconds }`.
 */
export function toMeetingFolder(input, opts = {}) {
  const parsed = splitLongTurns(parseGranolaTranscript(input.transcript), opts);
  const { turns, seconds } = estimateTimeline(parsed, opts);
  const meta = meetingRecord(input, { ...opts, seconds, count: turns.length });
  return {
    folder: folderNameFor(input.startedAt, meta.title),
    turns,
    seconds,
    files: {
      'meeting.json': JSON.stringify(meta, null, 2) + '\n',
      'transcript.md': toTranscriptMd(turns),
      // The notes pane is the user's own, and an import has nothing to put in
      // it. An empty file rather than none, so the folder looks like every other.
      'my-notes.md': '',
    },
  };
}
