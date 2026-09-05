/**
 * MIN · meeting-schema tests. Run: node app/recording.test.js
 *
 * No framework, by the same reasoning as the module itself: a test runner is a
 * dependency, and meeting-schema.js is imported by four callers with no shared
 * module graph, so its test has to run under plain `node` with no setup at all.
 * The output is shaped like calendar.test.js and mcp/smoke-test.js.
 *
 * Every fixture below is the real thing rather than a convenient one. SCHEMA_1 is
 * byte-for-byte the shape main.js writes in the save-meeting handler, tracks came
 * out of trackMeta, timeline came out of record.js, RESULTS is what runWorker
 * resolves with, and the transcript bodies are what buildTranscript renders. A
 * fixture that is only nearly right would let an arithmetic error pass.
 *
 * Timezone independence: every instant is written and asserted as a UTC ISO
 * string, which is the same on every machine.
 */

import {
  segmentsOf,
  pendingSegments,
  nextSegment,
  withSegment,
  offsetSamples,
  shiftResults,
  appendTranscript,
} from './meeting-schema.js';
import { isLiveComplete } from './live.js';

/* ------------------------------------------------------------- tiny harness */

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks++;
  if (!condition) failures++;
  const line = `${condition ? '  ok  ' : '  FAIL'} ${label}`;
  console.log(detail && !condition ? `${line} , ${detail}` : line);
}

function show(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function eq(label, actual, expected) {
  const same = Array.isArray(actual) || (actual && typeof actual === 'object')
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : Object.is(actual, expected);
  ok(label, same, `got ${show(actual)} want ${show(expected)}`);
}

function section(name) {
  console.log(`\n${name}`);
}

/** Asserts the refusal AND its code, because the code is what callers branch on. */
function throwsWith(label, code, fn) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(label, Boolean(err) && err.code === code, err ? `code ${show(err.code)}` : 'did not throw');
}

/** A JSON snapshot is the only honest way to prove nothing deep was mutated. */
const frozenCopy = (v) => JSON.stringify(v);

/* ------------------------------------------------------------------ helpers */

const T = (h, m, s = 0) => `2026-09-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;

/** transcribe.js hhmmss, copied so a rendered line is the real rendered line. */
const hhmmss = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** buildTranscript's line format, without its folding, for the pipeline check. */
const renderLines = (results) =>
  results
    .flatMap((r) => r.segments)
    .sort((a, b) => a.start - b.start || (a.speaker === 'You' ? -1 : 1))
    .map((s) => `[${hhmmss(s.start)}] ${s.speaker}: ${s.text}`)
    .join('\n') + '\n';

/* ---------------------------------------------------------------- fixtures */

/**
 * Exactly what ipcMain.handle('save-meeting') writes: the same key order, the
 * same schema number, tracks straight out of trackMeta and a timeline straight
 * out of record.js. A ten minute call that has not been resumed yet.
 */
const SCHEMA_1 = {
  schema: 1,
  title: 'Case interview practice',
  startedAt: T(15, 0),
  endedAt: T(15, 10),
  durationSeconds: 600,
  sampleRate: 16000,
  tracks: {
    mic: { capturedSeconds: 600, deficitSeconds: 0.02, peak: 0.5, rms: 0.02, voicedSeconds: 300, silent: false },
    system: { capturedSeconds: 600, deficitSeconds: 0.05, peak: 0.4, rms: 0.01, voicedSeconds: 200, silent: false },
  },
  timeline: {
    deviceEvents: [{ at: 1000, event: 'devicechange' }],
    mic: { renderBlocks: 100, emptyBlocks: 2 },
    system: { renderBlocks: 100, emptyBlocks: 0 },
  },
  calendarEvent: null,
  audioDisposition: 'kept: delete after transcription succeeds',
  transcript: null,
};

/** The second capture, opened on a different headset at a different level. */
const SECOND_CAPTURE = {
  startedAt: T(15, 30),
  endedAt: T(15, 40),
  existing: ['mic.wav', 'SYSTEM.WAV', 'my-notes.md', 'meeting.json'],
  tracks: {
    mic: { capturedSeconds: 600, deficitSeconds: 0.01, peak: 0.9, rms: 0.04, voicedSeconds: 500, silent: false },
    system: { capturedSeconds: 600, deficitSeconds: 0, peak: 0.2, rms: 0.005, voicedSeconds: 100, silent: false },
  },
  timeline: {
    deviceEvents: [{ at: 500, event: 'track-ended', label: 'Headset (Jabra)' }],
    mic: { renderBlocks: 50, emptyBlocks: 1 },
    system: { renderBlocks: 50, emptyBlocks: 0 },
  },
};

/** What runWorker resolves with, one entry per track, ASR times from ITS zero. */
const RESULTS = [
  {
    speaker: 'You',
    ok: true,
    crashed: false,
    error: null,
    exitCode: 0,
    meta: { segments: 2, voicedSeconds: 5, totalSeconds: 600 },
    segments: [
      { start: 0.4, end: 2.1, text: 'Where were we on cost to serve?', speaker: 'You', rms: 0.031 },
      { start: 9.8, end: 12.4, text: 'Right, the regional split.', speaker: 'You', rms: 0.028 },
    ],
  },
  {
    speaker: 'Them',
    ok: true,
    crashed: false,
    error: null,
    exitCode: 0,
    meta: { segments: 1, voicedSeconds: 3, totalSeconds: 600 },
    segments: [{ start: 3.2, end: 6.9, text: 'We had just opened the model.', speaker: 'Them', rms: 0.044 }],
  },
];

/** transcript.md for segment 1, as buildTranscript rendered it. */
const BODY_1 = [
  '[00:00:05] You: Thanks for making the time.',
  '[00:00:20] Them: Of course. Shall we start with the operating model?',
  '[00:03:44] You: Yes. I pulled the cost to serve by region.',
].join('\n') + '\n';

/** transcript.md for segment 2, already shifted onto the meeting clock. */
const BODY_2 = [
  '[00:30:00] You: Where were we on cost to serve?',
  '[00:30:03] Them: We had just opened the model.',
  '[00:30:09] You: Right, the regional split.',
].join('\n') + '\n';

/* -------------------------------------------------------------------- tests */

section('segmentsOf , a schema 1 meeting read as one segment');
{
  const segs = segmentsOf(SCHEMA_1);
  eq('an unresumed meeting is exactly one segment', segs.length, 1);
  eq('numbered from one', segs[0].index, 1);
  eq('it carries the meeting start', segs[0].startedAt, T(15, 0));
  eq('and the meeting end', segs[0].endedAt, T(15, 10));
  eq('and the recorded duration', segs[0].durationSeconds, 600);
  eq('it starts the meeting clock', segs[0].offsetSeconds, 0);
  eq('it owns the schema 1 file names', segs[0].files, { mic: 'mic.wav', system: 'system.wav' });
  eq('track integrity is carried through', segs[0].tracks, SCHEMA_1.tracks);
  eq('the timeline is carried through', segs[0].timeline, SCHEMA_1.timeline);
  eq('transcript is carried through', segs[0].transcript, null);
  eq('audioDisposition is renamed to audio', segs[0].audio, 'kept: delete after transcription succeeds');
  ok('nothing on disk was rewritten', SCHEMA_1.schema === 1 && SCHEMA_1.segments === undefined);
}
{
  const noDuration = { startedAt: T(15, 0), endedAt: T(15, 10), tracks: SCHEMA_1.tracks };
  eq('a missing durationSeconds is derived from the two instants', segmentsOf(noDuration)[0].durationSeconds, 600);
  const noClock = { durationSeconds: 42, tracks: SCHEMA_1.tracks };
  eq('with no instants at all the declared duration stands', segmentsOf(noClock)[0].durationSeconds, 42);
  eq('and its times stay null rather than being invented', segmentsOf(noClock)[0].startedAt, null);
}

section('segmentsOf , a schema 2 meeting');
{
  const meta = withSegment(SCHEMA_1, nextSegment(SCHEMA_1, SECOND_CAPTURE));
  const segs = segmentsOf(meta);
  eq('both segments come back', segs.length, 2);
  eq('in the order they were captured', segs.map((s) => s.index), [1, 2]);
  eq('the stored segments are returned, not re-synthesised', segs[1].files.mic, 'mic-2.wav');
  eq('schema 2 is recorded on the meeting', meta.schema, 2);
}

section('segmentsOf , garbage');
eq('null is no segments', segmentsOf(null), []);
eq('undefined is no segments', segmentsOf(undefined), []);
eq('a number is no segments', segmentsOf(42), []);
eq('a string is no segments', segmentsOf('meeting.json'), []);
eq('an array is not a meeting', segmentsOf([SCHEMA_1]), []);
eq('an empty object describes no recording', segmentsOf({}), []);
eq('a meeting with only a title describes no recording', segmentsOf({ title: 'Untitled' }), []);
eq('a non-array segments field falls back to the legacy read', segmentsOf({ segments: 'two', startedAt: T(15, 0), endedAt: T(15, 10) }).length, 1);
eq('an explicitly empty segments array means no segments', segmentsOf({ ...SCHEMA_1, schema: 2, segments: [] }), []);
eq('a segments array of junk is not back-filled either', segmentsOf({ ...SCHEMA_1, schema: 2, segments: [null, 7, 'x'] }), []);
eq('an unparseable startedAt still yields the segment', segmentsOf({ startedAt: 'sometime tuesday' }).length, 1);
eq('and its duration floors at zero rather than going NaN', segmentsOf({ startedAt: 'sometime tuesday' })[0].durationSeconds, 0);
eq('an endedAt before startedAt cannot make a negative duration', segmentsOf({ startedAt: T(15, 10), endedAt: T(15, 0) })[0].durationSeconds, 0);

section('pendingSegments , what is still owed a transcript');
eq('a fresh schema 1 meeting owes one', pendingSegments(SCHEMA_1).length, 1);
eq('a finished one owes nothing', pendingSegments({ ...SCHEMA_1, transcript: { complete: true } }).length, 0);
eq('a partial transcript still owes it', pendingSegments({ ...SCHEMA_1, transcript: { complete: false } }).length, 1);
eq('a transcript record with no complete flag still owes it', pendingSegments({ ...SCHEMA_1, transcript: { at: T(16, 0) } }).length, 1);
{
  const done = { complete: true };
  const meta = {
    schema: 2,
    startedAt: T(15, 0),
    segments: [
      { index: 1, startedAt: T(15, 0), endedAt: T(15, 10), durationSeconds: 600, offsetSeconds: 0, files: { mic: 'mic.wav', system: 'system.wav' }, transcript: done },
      { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), durationSeconds: 600, offsetSeconds: 1800, files: { mic: 'mic-2.wav', system: 'system-2.wav' }, transcript: null },
      { index: 3, startedAt: T(16, 0), endedAt: T(16, 5), durationSeconds: 300, offsetSeconds: 3600, files: { mic: 'mic-3.wav', system: 'system-3.wav' }, transcript: { complete: false } },
    ],
  };
  eq('only the unfinished segments of a resumed meeting', pendingSegments(meta).map((s) => s.index), [2, 3]);
}
eq('garbage owes nothing', pendingSegments(null), []);
eq('an empty segments array owes nothing', pendingSegments({ ...SCHEMA_1, schema: 2, segments: [] }), []);

section('nextSegment , the first capture of a meeting');
{
  const seg = nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10) });
  eq('index 1', seg.index, 1);
  eq('keeps the schema 1 names so an unresumed folder looks untouched', seg.files, { mic: 'mic.wav', system: 'system.wav' });
  eq('starts the meeting clock', seg.offsetSeconds, 0);
  eq('duration derived from the two instants', seg.durationSeconds, 600);
  eq('times normalised to ISO', [seg.startedAt, seg.endedAt], [T(15, 0), T(15, 10)]);
  eq('no tracks were offered, so none are claimed', seg.tracks, null);
  eq('no timeline either', seg.timeline, null);
  eq('and no transcript yet', seg.transcript, null);
}
eq('epoch milliseconds are accepted, which is what record.js has',
  nextSegment(null, { startedAt: Date.parse(T(15, 0)), endedAt: Date.parse(T(15, 10)) }).startedAt, T(15, 0));
eq('a Date is accepted too', nextSegment(null, { startedAt: new Date(T(15, 0)), endedAt: new Date(T(15, 10)) }).endedAt, T(15, 10));
eq('an explicit durationSeconds beats the wall arithmetic',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10), durationSeconds: 597.31 }).durationSeconds, 597.31);
eq('and is rounded to the hundredth',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10), durationSeconds: 597.31666 }).durationSeconds, 597.32);

section('nextSegment , the second and third captures');
{
  const seg2 = nextSegment(SCHEMA_1, SECOND_CAPTURE);
  eq('index 2', seg2.index, 2);
  eq('file names carry the number', seg2.files, { mic: 'mic-2.wav', system: 'system-2.wav' });
  eq('offset is measured from the meeting start, not the previous end', seg2.offsetSeconds, 1800);
  eq('duration is this capture only', seg2.durationSeconds, 600);
  eq('offered tracks are attached', seg2.tracks, SECOND_CAPTURE.tracks);
  eq('offered timeline is attached unshifted', seg2.timeline, SECOND_CAPTURE.timeline);

  const meta2 = withSegment(SCHEMA_1, seg2);
  const seg3 = nextSegment(meta2, {
    startedAt: T(16, 0),
    endedAt: T(16, 5),
    existing: ['mic.wav', 'system.wav', 'mic-2.wav', 'system-2.wav', 'meeting.json'],
  });
  eq('index 3', seg3.index, 3);
  eq('and the third pair of names', seg3.files, { mic: 'mic-3.wav', system: 'system-3.wav' });
  eq('still anchored on the first start, so no rounding accumulates', seg3.offsetSeconds, 3600);
}

section('nextSegment , the existing file listing');
eq('a fresh folder that already holds a half written mic.wav skips to 2',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10), existing: ['mic.wav'] }).files,
  { mic: 'mic-2.wav', system: 'system-2.wav' });
eq('the pair moves together even when only one side is taken',
  nextSegment(SCHEMA_1, { startedAt: T(15, 30), endedAt: T(15, 40), existing: ['system-2.wav'] }).files,
  { mic: 'mic-3.wav', system: 'system-3.wav' });
eq('names are compared case insensitively, because NTFS does',
  nextSegment(SCHEMA_1, { startedAt: T(15, 30), endedAt: T(15, 40), existing: ['MIC-2.WAV'] }).files,
  { mic: 'mic-3.wav', system: 'system-3.wav' });
eq('the search keeps walking past a run of orphans',
  nextSegment(SCHEMA_1, { startedAt: T(15, 30), endedAt: T(15, 40), existing: ['MIC-2.WAV', 'system-2.wav', 'Mic-3.wav'] }).files,
  { mic: 'mic-4.wav', system: 'system-4.wav' });
eq('the index is the segment ordinal, not the file number',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10), existing: ['mic.wav', 'system.wav'] }).index, 1);
eq('a non-array listing is ignored rather than throwing',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10), existing: 'mic.wav' }).files.mic, 'mic.wav');
eq('junk inside the listing is skipped',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10), existing: [null, 42, {}, 'mic.wav'] }).files.mic, 'mic-2.wav');

section('nextSegment , offsets a long meeting actually produces');
eq('a three hour gap is three hours of offset',
  nextSegment(SCHEMA_1, { startedAt: T(18, 0), endedAt: T(18, 10) }).offsetSeconds, 10800);
eq('offsets are rounded to the hundredth',
  nextSegment({ startedAt: '2026-09-04T15:00:00.000Z' }, { startedAt: '2026-09-04T15:00:01.238Z', endedAt: T(15, 10) }).offsetSeconds, 1.24);
eq('a capture that starts before the meeting cannot go negative',
  nextSegment(SCHEMA_1, { startedAt: T(14, 50), endedAt: T(15, 30) }).offsetSeconds, 0);

section('nextSegment , refusals');
throwsWith('no options at all is refused', 'BADTIME', () => nextSegment(null));
throwsWith('a missing startedAt is refused', 'BADTIME', () => nextSegment(null, { endedAt: T(15, 10) }));
throwsWith('a missing endedAt is refused', 'BADTIME', () => nextSegment(null, { startedAt: T(15, 0) }));
throwsWith('an unparseable time is refused rather than coerced to NaN', 'BADTIME', () => nextSegment(null, { startedAt: 'soon', endedAt: 'later' }));
throwsWith('an empty string is refused', 'BADTIME', () => nextSegment(null, { startedAt: '', endedAt: T(15, 10) }));
throwsWith('endedAt before startedAt is refused', 'BADTIME', () => nextSegment(null, { startedAt: T(15, 10), endedAt: T(15, 0) }));
eq('a zero length capture is allowed, because a user can stop instantly',
  nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 0) }).durationSeconds, 0);
throwsWith('a meeting.json with no readable start refuses to guess one', 'NOMETA',
  () => nextSegment({ endedAt: T(15, 10), durationSeconds: 600 }, { startedAt: T(15, 30), endedAt: T(15, 40) }));
throwsWith('and so does one whose startedAt is unparseable', 'NOMETA',
  () => nextSegment({ startedAt: 'sometime tuesday', durationSeconds: 600 }, { startedAt: T(15, 30), endedAt: T(15, 40) }));
throwsWith('a schema 2 skeleton with no clock refuses too', 'NOMETA',
  () => nextSegment({ schema: 2, segments: [] }, { startedAt: T(15, 30), endedAt: T(15, 40) }));
eq('but a meta that describes no recording lets the capture start the clock',
  nextSegment({ title: 'Untitled' }, { startedAt: T(15, 30), endedAt: T(15, 40) }).offsetSeconds, 0);
{
  let code = null;
  try { nextSegment({ endedAt: T(15, 10) }, { startedAt: T(15, 30), endedAt: T(15, 40) }); } catch (e) { code = e.code; }
  eq('the refusal is an Error carrying .code', code, 'NOMETA');
}

section('withSegment , the recomputed meeting');
{
  const seg2 = nextSegment(SCHEMA_1, SECOND_CAPTURE);
  const meta = withSegment(SCHEMA_1, seg2);

  eq('schema is bumped to 2', meta.schema, 2);
  eq('two segments are stored', meta.segments.length, 2);
  eq('durationSeconds is captured time, the sum of the segments', meta.durationSeconds, 1200);
  eq('spanSeconds is wall time, first start to last end', meta.spanSeconds, 2400);
  eq('endedAt moves to the last end', meta.endedAt, T(15, 40));
  eq('startedAt stays the first start', meta.startedAt, T(15, 0));
  eq('title is untouched', meta.title, SCHEMA_1.title);
  eq('sampleRate is untouched', meta.sampleRate, 16000);
  eq('calendarEvent is untouched', meta.calendarEvent, null);
  eq('audioDisposition is untouched', meta.audioDisposition, SCHEMA_1.audioDisposition);

  eq('captured seconds add up per track', [meta.tracks.mic.capturedSeconds, meta.tracks.system.capturedSeconds], [1200, 1200]);
  eq('deficits add up too', [meta.tracks.mic.deficitSeconds, meta.tracks.system.deficitSeconds], [0.03, 0.05]);
  eq('voiced seconds add up', [meta.tracks.mic.voicedSeconds, meta.tracks.system.voicedSeconds], [800, 300]);
  eq('peak is the loudest moment anywhere', [meta.tracks.mic.peak, meta.tracks.system.peak], [0.9, 0.4]);
  eq('rms is re-derived from power, not averaged', meta.tracks.mic.rms, 0.03162);
  eq('and weighted by each segment length', meta.tracks.system.rms, 0.00791);
  eq('silent stays false when either segment had signal', [meta.tracks.mic.silent, meta.tracks.system.silent], [false, false]);

  eq('device events are merged onto the meeting clock', meta.timeline.deviceEvents,
    [{ at: 1000, event: 'devicechange' }, { at: 1800500, event: 'track-ended', label: 'Headset (Jabra)' }]);
  eq('block counts add up', meta.timeline.mic, { renderBlocks: 150, emptyBlocks: 3 });
  eq('and on the other track too', meta.timeline.system, { renderBlocks: 150, emptyBlocks: 0 });

  const seg3 = nextSegment(meta, { startedAt: T(16, 0), endedAt: T(16, 5), existing: ['mic.wav', 'system.wav', 'mic-2.wav', 'system-2.wav'] });
  const meta3 = withSegment(meta, seg3);
  eq('a third stop keeps summing captured time', meta3.durationSeconds, 1500);
  eq('and keeps widening the wall window', meta3.spanSeconds, 3900);
  eq('and the aggregate is recomputed, never doubled', meta3.timeline.mic, { renderBlocks: 150, emptyBlocks: 3 });
  eq('the device events are not shifted twice either', meta3.timeline.deviceEvents,
    [{ at: 1000, event: 'devicechange' }, { at: 1800500, event: 'track-ended', label: 'Headset (Jabra)' }]);
  eq('and the tracks are not double counted', meta3.tracks.mic.capturedSeconds, 1200);
}

section('withSegment , the caller keeps its copy');
{
  const before = frozenCopy(SCHEMA_1);
  const seg = nextSegment(SCHEMA_1, SECOND_CAPTURE);
  const segBefore = frozenCopy(seg);
  const meta = withSegment(SCHEMA_1, seg);

  eq('the meeting.json the caller read from disk is untouched', frozenCopy(SCHEMA_1), before);
  eq('and so is the segment it was handed', frozenCopy(seg), segBefore);
  ok('the result is a different object', meta !== SCHEMA_1);
  ok('with a different tracks object', meta.tracks !== SCHEMA_1.tracks);
  ok('and a different timeline object', meta.timeline !== SCHEMA_1.timeline);
  eq('the original still says schema 1', SCHEMA_1.schema, 1);
  eq('the original still has no segments array', SCHEMA_1.segments, undefined);
  eq('the original duration is still one capture', SCHEMA_1.durationSeconds, 600);

  const again = withSegment(meta, nextSegment(meta, { startedAt: T(16, 0), endedAt: T(16, 5) }));
  eq('a second round does not disturb the first result', meta.segments.length, 2);
  eq('while the new one has three', again.segments.length, 3);
}

section('withSegment , a meeting built from nothing');
{
  const seg = nextSegment(null, { startedAt: T(15, 0), endedAt: T(15, 10) });
  const meta = withSegment(null, seg);
  eq('the meeting gets a start, which library.js and the MCP list read', meta.startedAt, T(15, 0));
  eq('and an end', meta.endedAt, T(15, 10));
  eq('and a duration', meta.durationSeconds, 600);
  eq('span equals capture when nothing was stopped', meta.spanSeconds, 600);
  eq('one segment', meta.segments.length, 1);

  const titled = withSegment({ title: 'Untitled', sampleRate: 16000 }, seg);
  eq('a partial base gets its start too', titled.startedAt, T(15, 0));
  eq('and keeps what it already had', titled.title, 'Untitled');
}

section('withSegment , refusals and thin input');
throwsWith('a missing segment is refused', 'BADSEGMENT', () => withSegment(SCHEMA_1, null));
throwsWith('a number is not a segment', 'BADSEGMENT', () => withSegment(SCHEMA_1, 42));
throwsWith('a string is not a segment', 'BADSEGMENT', () => withSegment(SCHEMA_1, 'mic-2.wav'));
throwsWith('an array is not a segment', 'BADSEGMENT', () => withSegment(SCHEMA_1, []));
{
  const bare = withSegment(SCHEMA_1, { index: 2, files: { mic: 'mic-2.wav', system: 'system-2.wav' } });
  eq('a segment with no clock contributes no time', bare.durationSeconds, 600);
  eq('and cannot shrink the wall window', bare.spanSeconds, 600);
  eq('the existing endedAt survives', bare.endedAt, T(15, 10));
  eq('and so do the existing tracks', bare.tracks.mic.capturedSeconds, 600);
}

section('withSegment , attacks on meeting.json');
{
  const noStart = {
    schema: 2,
    title: 'Case interview practice',
    segments: [{ index: 1, startedAt: T(15, 0), endedAt: T(15, 10), durationSeconds: 600, offsetSeconds: 0, files: { mic: 'mic.wav', system: 'system.wav' } }],
  };
  const meta = withSegment(noStart, { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), durationSeconds: 600, offsetSeconds: 1800, files: { mic: 'mic-2.wav', system: 'system-2.wav' } });
  eq('a meeting.json with no top level startedAt recovers it from its segments', meta.startedAt, T(15, 0));
  eq('and its span is measured from there', meta.spanSeconds, 2400);
}
{
  const nothing = { title: 'Untitled', endedAt: T(15, 10), durationSeconds: 600 };
  const meta = withSegment(nothing, { index: 2, files: { mic: 'mic-2.wav', system: 'system-2.wav' } });
  eq('with no instant anywhere the start stays null rather than being invented', meta.startedAt, null);
}
{
  const backwards = { ...SCHEMA_1, startedAt: T(15, 10), endedAt: T(15, 0), durationSeconds: undefined };
  const meta = withSegment(backwards, { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), durationSeconds: 600, offsetSeconds: 1200, files: { mic: 'mic-2.wav', system: 'system-2.wav' } });
  eq('an endedAt before startedAt cannot make a negative duration', meta.durationSeconds, 600);
  eq('nor a negative span', meta.spanSeconds >= 0, true);
  eq('and the end moves to the real last end', meta.endedAt, T(15, 40));
}
{
  const zero = { ...SCHEMA_1, schema: 2, segments: [] };
  eq('a schema 2 skeleton is not back-filled with a phantom segment', segmentsOf(zero).length, 0);
  const seg = nextSegment(zero, { startedAt: T(15, 30), endedAt: T(15, 40) });
  eq('so the first real capture is segment 1', seg.index, 1);
  eq('and it claims the schema 1 file names, which transcribe.js looks for', seg.files, { mic: 'mic.wav', system: 'system.wav' });
  eq('placed against the declared meeting start', seg.offsetSeconds, 1800);
  const meta = withSegment(zero, seg);
  eq('and the duration is that capture, not it plus a phantom', meta.durationSeconds, 600);
  eq('one segment on the meeting', meta.segments.length, 1);
}
{
  const stringy = { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), durationSeconds: '600', offsetSeconds: 1800, files: { mic: 'mic-2.wav', system: 'system-2.wav' } };
  const meta = withSegment(SCHEMA_1, stringy);
  eq('a durationSeconds written as a string still counts, from its instants', meta.durationSeconds, 1200);
  eq('and the wall window is unaffected', meta.spanSeconds, 2400);
}
{
  const missing = { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), offsetSeconds: 1800, files: { mic: 'mic-2.wav', system: 'system-2.wav' } };
  eq('a segment with no durationSeconds at all is measured instead of dropped', withSegment(SCHEMA_1, missing).durationSeconds, 1200);
}
{
  const unmeasurable = { index: 2, durationSeconds: 'ten minutes', files: { mic: 'mic-2.wav', system: 'system-2.wav' } };
  eq('a segment with neither a number nor instants contributes nothing', withSegment(SCHEMA_1, unmeasurable).durationSeconds, 600);
}
{
  const outOfOrder = {
    schema: 2,
    startedAt: T(15, 30),
    segments: [
      { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), durationSeconds: 600, offsetSeconds: 1800, files: { mic: 'mic-2.wav', system: 'system-2.wav' } },
      { index: 1, startedAt: T(15, 0), endedAt: T(15, 10), durationSeconds: 600, offsetSeconds: 0, files: { mic: 'mic.wav', system: 'system.wav' } },
    ],
  };
  const meta = withSegment(outOfOrder, { index: 3, startedAt: T(16, 0), endedAt: T(16, 5), durationSeconds: 300, offsetSeconds: 3600, files: { mic: 'mic-3.wav', system: 'system-3.wav' } });
  eq('a segments array out of order still spans the whole meeting', meta.spanSeconds, 3900);
  eq('and reports the earliest start', meta.startedAt, T(15, 0));
  eq('captured time does not care about order', meta.durationSeconds, 1500);
}
{
  const halfRead = {
    schema: 2,
    startedAt: T(15, 0),
    segments: [
      { index: 1, startedAt: null, endedAt: null, durationSeconds: 600, offsetSeconds: 0, files: { mic: 'mic.wav', system: 'system.wav' } },
      { index: 2, startedAt: T(15, 30), endedAt: T(15, 40), durationSeconds: 600, offsetSeconds: 1800, files: { mic: 'mic-2.wav', system: 'system-2.wav' } },
    ],
  };
  const meta = withSegment(halfRead, { index: 3, startedAt: T(16, 0), endedAt: T(16, 5), durationSeconds: 300, offsetSeconds: 3600, files: { mic: 'mic-3.wav', system: 'system-3.wav' } });
  eq('a segment with no readable clock does not cost the meeting its declared start', meta.startedAt, T(15, 0));
  eq('so the wall window is not cut short either', meta.spanSeconds, 3900);
  eq('and captured time still counts it', meta.durationSeconds, 1500);
}

section('offsetSamples , seeking in PCM rather than in text');
eq('a whole second at the shipped rate', offsetSamples(1, 16000), 16000);
eq('the default rate is 16 kHz', offsetSamples(1), 16000);
eq('a fractional offset is rounded to a sample', offsetSamples(1.5), 24000);
eq('another rate is honoured', offsetSamples(1.5, 48000), 72000);
eq('a three hour offset does not overflow', offsetSamples(10800, 16000), 172800000);
eq('zero is zero', offsetSamples(0), 0);
eq('a non-finite offset is zero, not NaN', offsetSamples(NaN), 0);
eq('a string offset is zero, not NaN', offsetSamples('1.5'), 0);
eq('null is zero', offsetSamples(null), 0);
eq('undefined takes the default rate and a zero offset', offsetSamples(undefined), 0);
eq('an explicit null rate is zero rather than NaN', offsetSamples(1.5, null), 0);
eq('an undefined rate falls back to the default', offsetSamples(1.5, undefined), 24000);

section('shiftResults , moving a worker result onto the meeting clock');
{
  const before = frozenCopy(RESULTS);
  const shifted = shiftResults(RESULTS, 1800);

  eq('every result comes back', shifted.length, 2);
  eq('the first word of segment 2 lands after the gap', shifted[0].segments[0].start, 1800.4);
  eq('and its end moves with it', shifted[0].segments[0].end, 1802.1);
  eq('the other track moves by the same amount', shifted[1].segments[0].start, 1803.2);
  eq('text is untouched', shifted[0].segments[0].text, 'Where were we on cost to serve?');
  eq('speaker is untouched', shifted[1].speaker, 'Them');
  eq('worker fields are untouched', [shifted[0].ok, shifted[0].exitCode], [true, 0]);
  eq('rms rides along', shifted[0].segments[0].rms, 0.031);
  eq('worker meta rides along', shifted[0].meta.segments, 2);

  eq('the caller still holds the unshifted results', frozenCopy(RESULTS), before);
  ok('a new outer array', shifted !== RESULTS);
  ok('a new result object', shifted[0] !== RESULTS[0]);
  ok('a new segments array', shifted[0].segments !== RESULTS[0].segments);
  ok('and a new segment object', shifted[0].segments[0] !== RESULTS[0].segments[0]);

  eq('a three hour offset is exact to the millisecond', shiftResults(RESULTS, 10800)[0].segments[0].start, 10800.4);
  eq('rounded to the millisecond, not left to float error', shiftResults(RESULTS, 0.1)[0].segments[0].start, 0.5);
  eq('a zero offset is the identity', shiftResults(RESULTS, 0)[0].segments[0].start, 0.4);
}
eq('a missing offset is treated as zero', shiftResults(RESULTS)[0].segments[0].start, 0.4);
eq('a string offset is treated as zero rather than concatenated', shiftResults(RESULTS, '1800')[0].segments[0].start, 0.4);
eq('a non-array is no results', shiftResults(null, 5), []);
eq('undefined is no results', shiftResults(undefined, 5), []);
eq('a result object is not an array of them', shiftResults(RESULTS[0], 5), []);
eq('junk entries pass through untouched', shiftResults([1, 'x', null], 5), [1, 'x', null]);
eq('a result with no segments array is copied, not dropped', shiftResults([{ speaker: 'You', ok: false, segments: null }], 5).length, 1);
eq('a segment with no times keeps them as they were', shiftResults([{ segments: [{ text: 'no clock' }] }], 5)[0].segments[0], { text: 'no clock' });
eq('a segment start that is not a number is left alone', shiftResults([{ segments: [{ start: 'x', end: 2 }] }], 5)[0].segments[0], { start: 'x', end: 7 });

section('appendTranscript , ordering across segments');
eq('segment 2 lands after segment 1', appendTranscript(BODY_1, BODY_2), BODY_1 + BODY_2);
eq('a retry of segment 1 landing after segment 2 still sorts by timestamp', appendTranscript(BODY_2, BODY_1), BODY_1 + BODY_2);
eq('three segments in any arrival order give one body',
  appendTranscript(appendTranscript(BODY_2, '[01:00:00] You: And that is where we left it.\n'), BODY_1),
  BODY_1 + BODY_2 + '[01:00:00] You: And that is where we left it.\n');
eq('two lines on the same second keep the order they arrived in',
  appendTranscript('[00:00:05] You: Alpha\n', '[00:00:05] Them: Beta\n'),
  '[00:00:05] You: Alpha\n[00:00:05] Them: Beta\n');
eq('a duplicated timestamp inside one body is not reordered',
  appendTranscript('[00:00:05] You: Alpha\n[00:00:05] Them: Beta\n', BODY_2).split('\n')[0],
  '[00:00:05] You: Alpha');
eq('an hour count past two digits still parses',
  appendTranscript('[100:00:00] You: Still going.\n', BODY_1),
  BODY_1 + '[100:00:00] You: Still going.\n');

section('appendTranscript , continuation lines');
{
  const folded = [
    '[00:00:05] You: Thanks for making the time.',
    'The model text can carry a new line, and this is it.',
    '[00:00:20] Them: Of course.',
  ].join('\n') + '\n';
  eq('a line with no timestamp stays with the entry above it',
    appendTranscript(folded, BODY_2), folded + BODY_2);
  eq('and it is not torn away when the entry is reordered',
    appendTranscript(BODY_2, folded), folded + BODY_2);
  eq('a continuation line is part of the identity of the entry',
    appendTranscript(folded, folded), folded);
}

section('appendTranscript , idempotence');
eq('the same body twice is a no-op', appendTranscript(BODY_1, BODY_1), BODY_1);
{
  const merged = appendTranscript(BODY_1, BODY_2);
  eq('re-adding segment 2 changes nothing', appendTranscript(merged, BODY_2), merged);
  eq('re-adding segment 1 changes nothing', appendTranscript(merged, BODY_1), merged);
  eq('re-adding the whole merged body changes nothing', appendTranscript(merged, merged), merged);
  eq('and a third pass is still stable', appendTranscript(appendTranscript(merged, BODY_1), BODY_2), merged);
}
eq('whitespace is not evidence of a different line',
  appendTranscript(BODY_1, '[00:00:05] You:    Thanks   for making the time.\n'), BODY_1);
eq('a CRLF copy of the same body is the same body',
  appendTranscript(BODY_1, BODY_1.replace(/\n/g, '\r\n')), BODY_1);
eq('a body missing its trailing new line is still the same body',
  appendTranscript(BODY_1, BODY_1.trimEnd()), BODY_1);

section('appendTranscript , empty inputs');
eq('nothing plus nothing is nothing', appendTranscript('', ''), '');
eq('null plus undefined is nothing', appendTranscript(null, undefined), '');
eq('no arguments at all is nothing', appendTranscript(), '');
eq('whitespace only is nothing', appendTranscript('   \n\n\t', '\n'), '');
eq('nothing plus a body is that body', appendTranscript('', BODY_1), BODY_1);
eq('a body plus nothing is that body', appendTranscript(BODY_1, ''), BODY_1);
eq('a body plus null is that body', appendTranscript(BODY_1, null), BODY_1);
eq('blank lines between the two bodies collapse', appendTranscript(BODY_1 + '\n\n\n', BODY_2), BODY_1 + BODY_2);
{
  const out = appendTranscript(BODY_1 + '\n\n\n', BODY_2);
  ok('the result ends in exactly one new line', out.endsWith('\n') && !out.endsWith('\n\n'), show(out.slice(-40)));
}

section('appendTranscript , text before the first entry');
{
  const headed = '# Case interview practice\n\n' + BODY_1;
  eq('a header survives the merge and stays on top', appendTranscript(headed, BODY_2), '# Case interview practice\n\n' + BODY_1 + BODY_2);
  eq('the same header on both sides is not duplicated', appendTranscript(headed, headed), headed);
  eq('a header on the incoming side alone is kept', appendTranscript(BODY_1, '# Notes\n\n' + BODY_2), '# Notes\n\n' + BODY_1 + BODY_2);
  eq('a body that is only a header is kept', appendTranscript('# Notes', ''), '# Notes\n');
  eq('a header with no entries takes entries from the other side', appendTranscript('# Notes', BODY_1), '# Notes\n\n' + BODY_1);
  eq('a merged body with a header is still idempotent', appendTranscript(appendTranscript(headed, BODY_2), headed), appendTranscript(headed, BODY_2));
  eq('a line that only looks like an entry, with a bad speaker, is preamble',
    appendTranscript('[00:00:05] Someone: not a turn\n', BODY_1), '[00:00:05] Someone: not a turn\n\n' + BODY_1);
}

section('appendTranscript , text a regex would choke on');
{
  const meta1 = '[00:00:05] You: Cost to serve is $1.2M (a 30% delta) [see slide 4] a*b+c?d^e|f\\g\n';
  const meta2 = '[00:00:09] Them: Use .* for the wildcard and \\d{2} for the year.\n';
  eq('metacharacters survive a round trip byte for byte', appendTranscript('', meta1), meta1);
  eq('and do not break the merge', appendTranscript(meta1, meta2), meta1 + meta2);
  eq('nor the de-duplication', appendTranscript(meta1, meta1), meta1);
  eq('a lone backslash at the end of a line survives', appendTranscript('', '[00:00:01] You: path C:\\Users\\Example\\\n'), '[00:00:01] You: path C:\\Users\\Example\\\n');
  eq('a dollar-brace sequence is not expanded', appendTranscript('', '[00:00:02] Them: ${meeting.title}\n'), '[00:00:02] Them: ${meeting.title}\n');
}

section('the pipeline , a stopped and resumed meeting end to end');
{
  const seg2 = nextSegment(SCHEMA_1, SECOND_CAPTURE);
  const meta = withSegment(SCHEMA_1, seg2);
  eq('the segment 2 offset the transcriber will use', seg2.offsetSeconds, 1800);
  eq('and the sample index that offset means', offsetSamples(seg2.offsetSeconds, meta.sampleRate), 28800000);

  const shifted = shiftResults(RESULTS, seg2.offsetSeconds);
  const rendered = renderLines(shifted);
  eq('the worker result renders onto the meeting clock', rendered, BODY_2);

  const full = appendTranscript(BODY_1, rendered);
  eq('and merges after segment 1 without interleaving', full, BODY_1 + BODY_2);
  eq('a retried run of the same segment changes nothing', appendTranscript(full, rendered), full);
  eq('the meeting reports both numbers', [meta.durationSeconds, meta.spanSeconds], [1200, 2400]);
  eq('captured time is what the realtime factor is computed against', meta.durationSeconds, 1200);
  ok('and the wall window is the larger of the two', meta.spanSeconds > meta.durationSeconds);
}

section('may the audio be deleted , the live completeness rule');
{
  /*
   * This flag is the only thing standing between a recording and rm. main.js
   * deletes mic.wav and system.wav when a live transcript comes back complete,
   * so "complete" has to mean "no hole in the middle", not "the worker ended
   * tidily". Both respawn paths make a hole and both have to count.
   *
   * The bug this pins down shipped once: the clean-exit branch incremented its
   * own counter and not `restarts`, so a session that respawned mid-recording
   * still reported complete, and the audio covering the gap was deleted.
   */
  ok('a clean run is complete', isLiveComplete({ ok: true, restarts: 0, cleanExits: 0 }));

  ok('a crash respawn is not', !isLiveComplete({ ok: true, restarts: 1, cleanExits: 0 }));
  ok('a clean-exit respawn is not either', !isLiveComplete({ ok: true, restarts: 0, cleanExits: 1 }));
  ok('nor six of them', !isLiveComplete({ ok: true, restarts: 0, cleanExits: 6 }));
  ok('nor one of each', !isLiveComplete({ ok: true, restarts: 1, cleanExits: 1 }));

  ok('a session that failed is never complete', !isLiveComplete({ ok: false, restarts: 0, cleanExits: 0 }));
  ok('not even with clean counters and a truthy-looking ok', !isLiveComplete({ ok: 1, restarts: 0, cleanExits: 0 }));

  // The defaults matter: main.js reads `result?.complete`, and an older or
  // partial result object must never fall through to "safe to delete".
  ok('an empty outcome is not complete', !isLiveComplete({}));
  ok('and neither is a missing one', !isLiveComplete());
  ok('an outcome carrying only ok defaults both counters to zero', isLiveComplete({ ok: true }));
}

/* ------------------------------------------------------------------ result */

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
