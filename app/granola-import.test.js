/**
 * MIN · Granola import tests. Run: node app/granola-import.test.js
 *
 * No framework, like the other suites. The fixture is the real shape: the
 * opening of an actual Granola export from this account, leading space and
 * two-space turn separators included.
 *
 * The test that matters most is the round trip. It parses the transcript.md
 * this module writes with MIN's OWN reader, `segmentsFromTranscript` from
 * conversation.js, rather than a copy of the rule. If the two ever disagree the
 * conversation would silently reorder or vanish in the note view, which is
 * exactly the failure a hand-written expectation here would not catch.
 */

import {
  parseGranolaTranscript, estimateTimeline, toTranscriptMd, folderNameFor,
  meetingRecord, toMeetingFolder, hhmmss, SECONDS_PER_WORD,
  splitLongTurns, MAX_WORDS_PER_LINE,
} from './granola-import.js';
import { segmentsFromTranscript } from './conversation.js';

let failures = 0;
let checks = 0;
function ok(label, condition, detail = '') {
  checks++;
  if (!condition) failures++;
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail && !condition ? ' , ' + detail : ''}`);
}
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(label, g === w, `got ${g}, want ${w}`);
}
const section = (t) => console.log(`\n${t}`);

// Verbatim from the Granola MCP, first four turns of "Quarterly Planning Review".
const REAL = ' Them: Hello.  Me: Hi, can you hear me?  Them: Morning, how are you?  Me: I\'m doing good. How are you doing?';

section('parsing a Granola transcript');
{
  const t = parseGranolaTranscript(REAL);
  eq('four turns out of the real fixture', t.length, 4);
  eq('speakers alternate, Me becomes You', t.map((x) => x.speaker), ['Them', 'You', 'Them', 'You']);
  eq('the first turn keeps its text', t[0].text, 'Hello.');
  eq('an apostrophe survives', t[3].text, "I'm doing good. How are you doing?");
  eq('neither Me nor Them is treated as a name', t.map((x) => x.name), [null, null, null, null]);
}
{
  const t = parseGranolaTranscript('  Casey Nolan: Welcome everyone.  Me: Thanks for having me.');
  eq('a named speaker becomes Them', t.map((x) => x.speaker), ['Them', 'You']);
  eq('but keeps the name', t[0].name, 'Casey Nolan');
  eq('and the name is not left in the text', t[0].text, 'Welcome everyone.');
}
{
  const t = parseGranolaTranscript('Dana R. Whitfield: A welcome address.');
  eq('an initial in a name is kept whole', t[0].name, 'Dana R. Whitfield');
}
{
  const t = parseGranolaTranscript('An unlabelled opening.  Me: And then me.');
  eq('text before the first label is not dropped', t.length, 2);
  eq('it is attributed to Them, not to you', [t[0].speaker, t[0].text], ['Them', 'An unlabelled opening.']);
}
{
  const t = parseGranolaTranscript(' Me: So the deal is: we ship on Friday.  Them: Agreed.');
  eq('a colon inside speech does not open a turn', t.length, 2);
  eq('the sentence stays whole', t[0].text, 'So the deal is: we ship on Friday.');
}
{
  eq('runs of whitespace inside a turn collapse', parseGranolaTranscript(' Me: a   b\n\nc')[0].text, 'a b c');
  eq('nothing in, nothing out', parseGranolaTranscript(''), []);
  eq('null in, nothing out', parseGranolaTranscript(null), []);
  eq('an unlabelled string is one Them turn', parseGranolaTranscript('just words').map((x) => x.speaker), ['Them']);
}

section('estimated timeline');
{
  const { turns, seconds } = estimateTimeline(parseGranolaTranscript(REAL));
  eq('the first turn starts at zero', turns[0].t0, 0);
  ok('stamps never go backwards', turns.every((t, i) => i === 0 || t.t0 >= turns[i - 1].t0));
  // "Hello." is one word, so the second turn starts one word in.
  eq('the second turn starts one word later', turns[1].t0, +(1 * SECONDS_PER_WORD).toFixed(2));
  // 1 + 5 + 4 + 7 = 17 words across the four turns.
  eq('the length is the whole word count at the pace constant', seconds, +(17 * SECONDS_PER_WORD).toFixed(2));
  eq('an empty transcript is zero seconds', estimateTimeline([]).seconds, 0);
}
{
  const { seconds } = estimateTimeline(parseGranolaTranscript(REAL), { secondsPerWord: 1 });
  eq('the pace is overridable', seconds, 17);
}

section('breaking up a wall of text');
{
  // A real case from this account: a webinar transcript where one speaker held
  // the floor for ten thousand characters under a single label.
  const long = { speaker: 'Them', name: null, text: Array.from({ length: 40 }, (_, i) => `Sentence number ${i} here.`).join(' ') };
  const out = splitLongTurns([long]);
  ok('a long turn becomes several lines', out.length > 1, `${out.length} lines`);
  ok('every line is within the limit or a single sentence',
    out.every((t) => t.text.split(/\s+/).filter(Boolean).length <= MAX_WORDS_PER_LINE));
  eq('the speaker is carried onto every piece', [...new Set(out.map((t) => t.speaker))], ['Them']);
  // The whole point: nothing may be reworded, reordered or lost.
  eq('and not one word is changed, dropped or reordered',
    out.map((t) => t.text).join(' '), long.text);
}
{
  const short = { speaker: 'You', name: null, text: 'Short enough to leave alone.' };
  eq('a short turn is untouched', splitLongTurns([short]), [short]);
  eq('nothing in, nothing out', splitLongTurns([]), []);
}
{
  // A run-on with no punctuation at all cannot be split without cutting a
  // clause, so it is left whole rather than chopped mid-thought.
  const huge = { speaker: 'Them', name: null, text: 'word '.repeat(120).trim() + '.' };
  const out = splitLongTurns([huge]);
  eq('an unpunctuated run-on is never cut in half', out.length, 1);
  eq('and survives intact', out[0].text, huge.text);
}
{
  // The real case: a speech recogniser emitting a hundred words before the
  // first full stop, but with commas where the speaker drew breath.
  const runOn = {
    speaker: 'Them', name: null,
    text: Array.from({ length: 14 }, (_, i) => `and then we looked at option ${i} carefully`).join(', ') + '.',
  };
  const out = splitLongTurns([runOn]);
  ok('a run-on sentence falls back to its commas', out.length > 1, `${out.length} lines`);
  ok('and every line comes in under the limit',
    out.every((t) => t.text.split(/\s+/).filter(Boolean).length <= MAX_WORDS_PER_LINE));
  eq('still without changing a word', out.map((t) => t.text).join(' '), runOn.text);
}
{
  const named = { speaker: 'Them', name: 'Casey Nolan', text: Array.from({ length: 30 }, (_, i) => `Point ${i} made clearly.`).join(' ') };
  const out = splitLongTurns([named]);
  ok('a named speaker keeps the name on each piece', out.every((t) => t.name === 'Casey Nolan'));
}

section('hhmmss');
{
  eq('zero', hhmmss(0), '00:00:00');
  eq('a minute and a half', hhmmss(90), '00:01:30');
  eq('an hour', hhmmss(3600), '01:00:00');
  eq('hours are never truncated', hhmmss(360000), '100:00:00');
  eq('a negative never reaches the file', hhmmss(-5), '00:00:00');
}

section('the transcript.md it writes');
{
  const { turns } = estimateTimeline(parseGranolaTranscript(REAL));
  const md = toTranscriptMd(turns);
  const lines = md.split('\n');
  ok('it opens by saying the times are estimated', /estimated/.test(lines[0]), lines[0]);
  eq('the header carries no stamp, so it cannot join a bubble', /^\[/.test(lines[0]), false);
  eq('the blank line after the header', lines[1], '');
  eq('the first spoken line', lines[2], '[00:00:00] Them: Hello.');
  eq('the file ends with a newline', md.endsWith('\n'), true);
  eq('the header can be turned off', toTranscriptMd(turns, { header: false }).split('\n')[0], '[00:00:00] Them: Hello.');
  eq('nothing in, nothing out', toTranscriptMd([]), '');
}
{
  const { turns } = estimateTimeline(parseGranolaTranscript(' Casey Nolan: Welcome.'));
  eq('a name rides inside the text, where MIN has no label for it',
    toTranscriptMd(turns, { header: false }).trim(), '[00:00:00] Them: Casey Nolan: Welcome.');
}

section("round trip through MIN's own reader");
{
  const { turns } = estimateTimeline(parseGranolaTranscript(REAL));
  const back = segmentsFromTranscript(toTranscriptMd(turns));
  eq('every turn survives the round trip', back.length, turns.length);
  eq('in the order it was spoken', back.map((s) => s.track), ['them', 'you', 'them', 'you']);
  eq('with the words intact', back.map((s) => s.text), turns.map((t) => t.text));
  ok('and stamps the reader will sort correctly', back.every((s, i) => i === 0 || s.t0 >= back[i - 1].t0));
  // The header line must not have been folded into the first bubble.
  eq('the header did not leak into the first line', back[0].text, 'Hello.');
}
{
  // The failure this whole design exists to avoid: with no stamps, MIN's reader
  // drops every line, because an unstamped line folds into the one above it and
  // the first has nothing above it.
  const unstamped = 'Them: Hello.\nYou: Hi there.\n';
  eq('an unstamped transcript would be read as empty, which is why stamps are estimated',
    segmentsFromTranscript(unstamped).length, 0);
}

section('folder name');
{
  const at = new Date(2026, 7, 20, 16, 30).toISOString();
  eq('stamp then slug, exactly as main.js builds it',
    folderNameFor(at, 'Quarterly Planning Review'), '2026-08-20-1630-quarterly-planning-review');
  eq('an empty title falls back', folderNameFor(at, ''), '2026-08-20-1630-untitled');
  eq('punctuation and emoji collapse to single hyphens', folderNameFor(at, '📞 Robin <> Alex'), '2026-08-20-1630-robin-alex');
  eq('the slug is capped at 48 characters', folderNameFor(at, 'x'.repeat(80)).slice(16).length, 48);
  eq('an unparsable date still yields a folder', folderNameFor('not a date', 'Hi'), '0000-00-00-0000-hi');
}

section('meeting.json');
{
  const meta = meetingRecord(
    { title: 'Wells Fargo', startedAt: '2026-08-13T18:00:00.000Z', participants: ['a@b.com', ' ', 'c@d.com'], meetingId: 'abc' },
    { seconds: 120, count: 4, importedAt: '2026-09-07T12:00:00.000Z' }
  );
  eq('schema 2', meta.schema, 2);
  eq('an empty segments array, so nothing hunts for a wav that never existed', meta.segments, []);
  eq('the duration is the estimate', meta.durationSeconds, 120);
  eq('participants become attendees, blanks dropped', meta.calendarEvent.attendees, ['a@b.com', 'c@d.com']);
  eq('but it is not claimed to be a calendar event', meta.calendarEvent.uid, null);
  eq('no participants means no calendar event at all', meetingRecord({ title: 'x' }, {}).calendarEvent, null);
  eq('the transcript is marked complete, so no post-pass is offered', meta.transcript.complete, true);
  eq('and marked estimated', meta.transcript.timestamps, 'estimated');
  eq('the source is recorded', meta.imported.app, 'Granola');
  eq('with the id it came from', meta.imported.meetingId, 'abc');
  ok('and a plain-language note about the times', /not a record/.test(meta.imported.note));
  eq('the title falls back rather than going empty', meetingRecord({}, {}).title, 'Untitled');
}

section('a whole meeting folder');
{
  const out = toMeetingFolder({
    title: 'Quarterly Planning Review',
    startedAt: new Date(2026, 7, 20, 16, 30).toISOString(),
    participants: ['jordan@example.com'],
    meetingId: 'aaaa1111',
    transcript: REAL,
  }, { importedAt: '2026-09-07T12:00:00.000Z' });

  eq('the folder is named MIN-style', out.folder, '2026-08-20-1630-quarterly-planning-review');
  eq('three files, the same three a recorded meeting has minus the audio',
    Object.keys(out.files).sort(), ['meeting.json', 'my-notes.md', 'transcript.md']);
  eq('the notes file is empty and present', out.files['my-notes.md'], '');
  const meta = JSON.parse(out.files['meeting.json']);
  eq('the meta counts the turns it wrote', meta.transcript.count, 4);
  eq('and its duration matches the timeline', meta.durationSeconds, out.seconds);
  eq('meeting.json ends with a newline like every other file MIN writes',
    out.files['meeting.json'].endsWith('\n'), true);
  eq('the transcript round trips from the file text',
    segmentsFromTranscript(out.files['transcript.md']).length, 4);
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
