/**
 * MIN · the meeting.json shape, and the arithmetic that survives a Stop/Resume.
 *
 * ZERO imports, on purpose. Four callers with no shared module graph read this
 * file: the renderer (a page inside Electron, no node built-ins on it), the main
 * process, transcribe.js under plain `node`, and the MCP bundle, which is rolled
 * up on its own and must not drag app code along. One `import` of node:path here
 * breaks two of the four; one import of an app module puts main-process code in
 * the renderer. So everything below is arithmetic on plain objects, and the test
 * runs with no setup at all.
 *
 * WHY SEGMENTS, NOT ONE GROWING RECORDING
 * Stop ends the capture, not the note. Resume starts a new capture into the SAME
 * folder. The obvious alternative, appending PCM onto the open wav, was rejected:
 * the second capture opens a NEW getDisplayMedia stream, so the device, the
 * sample rate and the channel layout can all differ from the first, and the
 * silence between the two is real time that no track carries samples for. Gluing
 * them would either invent that silence or pretend it never happened, and either
 * way the timestamps stop matching what was said. A segment keeps its own files,
 * its own track integrity and its own offset, and the meeting is the ordered sum.
 * It also means a crash mid-resume costs one segment, not the whole meeting.
 *
 * WHY TWO DURATIONS
 * `durationSeconds` is CAPTURED time, the sum of the segments: it is what the ASR
 * has to chew through, what the realtime factor is computed against, and what the
 * library shows, so it keeps the exact meaning schema 1 gave it. `spanSeconds` is
 * WALL time, first start to last end, which includes the gaps where nothing was
 * recorded. A one-hour call stopped for a twenty-minute break is 40 minutes of
 * audio inside a 60-minute window. Reporting the wall number as the duration
 * would make transcription look three times slower than it is; reporting the
 * captured number as the meeting length would tell the user their two-hour
 * meeting was fifty minutes. Both are true, so both are stored.
 *
 * WHY appendTranscript IS IDEMPOTENT
 * Transcription is retried. It is retried after a crash, after a worker abort,
 * by a second click the in-flight map did not catch, and by `--all` sweeping a
 * folder whose transcript.md is already there. Every one of those paths can hand
 * the same segment's lines to the same transcript.md a second time, and the audio
 * is deleted once the run succeeds, so a doubled transcript cannot be rebuilt
 * from source. Merging on (timestamp, text) makes a repeat a no-op rather than a
 * corruption, which is what lets the caller retry without first proving it has
 * not already run.
 *
 * Everything schema 1 wrote keeps its name and its meaning. main.js, the MCP
 * server, prompt.js and md.js read those fields and do not need to change.
 */

/* --------------------------------------------------------------- primitives */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A finite number, or null. `null` rather than NaN so `??` stays usable. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const round = (n, places) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * The two time forms this app actually produces: an ISO string (meeting.json)
 * and a millisecond epoch (Date.now() in record.js). Anything else is refused
 * rather than coerced, because Date.parse('soon') is NaN and NaN arithmetic
 * silently poisons every offset computed from it.
 */
function toMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const requireTime = (value, field) => {
  const ms = toMs(value);
  if (ms === null) throw fail(`${field} must be an ISO date string or a number of milliseconds`, 'BADTIME');
  return ms;
};

/** Segment 1 keeps the schema-1 names so an unresumed meeting looks untouched. */
const wavName = (track, n) => (n <= 1 ? `${track}.wav` : `${track}-${n}.wav`);

/**
 * A segment's audio file name, only if it is a plain name inside the meeting
 * folder.
 *
 * meeting.json is NOT this app's private memo. It is a plain file in a folder
 * the user can open, copy, sync between machines and receive from someone else,
 * which makes every string in it untrusted input. These names are joined onto
 * the meeting folder and then handed to stat, to a spawned transcriber and, in
 * main.js, to fsp.rm. A name of "../../../../Windows/System32/drivers/etc/hosts"
 * would escape the folder that confine() so carefully checked, because confine
 * checks the FOLDER and nothing re-checked the name joined onto it.
 *
 * Rejected rather than sanitised: a name that is not a bare file name is not a
 * near miss to be repaired, it is a meeting.json that no version of this app
 * ever wrote, and quietly turning it into something valid would hide that.
 *
 * A regex and no path module, on purpose. This file has ZERO imports because
 * four callers with no shared module graph read it, the renderer among them,
 * and a single `import` of node:path here would break two of the four.
 */
const SAFE_WAV = /^[A-Za-z0-9._-]+\.wav$/;
const safeName = (n) => (typeof n === 'string' && SAFE_WAV.test(n) && !n.includes('..') ? n : null);

/**
 * A segment with only the file names that are safe to act on. A rejected name
 * becomes null, which every reader already handles: it means "no audio here",
 * the same as a segment whose wavs have been deleted after transcription.
 */
function withSafeFiles(seg) {
  if (!isObj(seg.files)) return seg;
  return { ...seg, files: { ...seg.files, mic: safeName(seg.files.mic), system: safeName(seg.files.system) } };
}

/* ------------------------------------------------------------------ reading */

/**
 * Every segment of a meeting, whatever schema it was written in.
 *
 * A schema-1 meeting is not migrated on disk, it is read AS a one-segment
 * meeting here. Nothing rewrites a folder the user has not touched, and no code
 * downstream needs a `schema` check: it asks for segments and gets some.
 */
export function segmentsOf(meta) {
  if (!isObj(meta)) return [];

  // An explicit segments array is the meeting's own account of itself, an empty
  // one included. A schema-2 folder whose meeting.json is written at Start and
  // filled in at Stop is empty for the length of the first capture, and
  // synthesising a segment from the schema-1 fields there invents one: it claims
  // a mic.wav nothing wrote, tells pendingSegments there is audio to transcribe,
  // pushes the first real capture out to mic-2.wav where transcribe.js does not
  // look for it, and then adds the top-level durationSeconds to it a second time.
  // Every reader of a segment's file names goes through here, which is why the
  // check lives at this one chokepoint rather than at each of the four callers.
  if (Array.isArray(meta.segments)) return meta.segments.filter(isObj).map(withSafeFiles);

  // A meta with none of these describes no recording at all, so there is no
  // legacy segment to synthesise from it.
  const usable =
    meta.startedAt != null || meta.endedAt != null || num(meta.durationSeconds) !== null ||
    isObj(meta.tracks) || meta.timeline != null || meta.transcript != null;
  if (!usable) return [];

  const startMs = toMs(meta.startedAt);
  const endMs = toMs(meta.endedAt);
  let duration = num(meta.durationSeconds);
  if (duration === null) {
    duration = startMs !== null && endMs !== null ? (endMs - startMs) / 1000 : 0;
  }

  return [{
    index: 1,
    startedAt: meta.startedAt ?? null,
    endedAt: meta.endedAt ?? null,
    durationSeconds: Math.max(0, round(duration, 2)),
    offsetSeconds: 0,
    files: { mic: 'mic.wav', system: 'system.wav' },
    tracks: isObj(meta.tracks) ? meta.tracks : null,
    timeline: meta.timeline ?? null,
    transcript: meta.transcript ?? null,
    // schema 1 spells this `audioDisposition`; the segment field is `audio`.
    audio: meta.audio ?? meta.audioDisposition ?? null,
  }];
}

/** Segments still owed a transcript. Missing counts, and so does incomplete. */
export function pendingSegments(meta) {
  return segmentsOf(meta).filter((s) => !isObj(s.transcript) || s.transcript.complete !== true);
}

/* ------------------------------------------------------------------ writing */

/**
 * Where this segment sits on the meeting clock.
 *
 * The anchor is the FIRST segment's start, not the previous segment's end: an
 * offset chained off the previous end would accumulate the rounding of every
 * stop before it, and the transcript timestamps would drift away from the wall
 * clock over a long meeting. With nothing prior at all, this segment is the one
 * starting the clock. With something prior that has no readable time, the
 * meeting cannot be placed on a clock and the caller must not guess.
 */
function meetingStartMs(meta, prior, fallbackMs) {
  if (prior.length) {
    const first = toMs(prior[0].startedAt);
    if (first !== null) return first;
  }
  if (isObj(meta)) {
    const declared = toMs(meta.startedAt);
    if (declared !== null) return declared;
    if (prior.length || meta.startedAt !== undefined || meta.segments !== undefined) {
      throw fail('Cannot tell when this meeting started, so a segment cannot be placed in it', 'NOMETA');
    }
  }
  return fallbackMs;
}

/**
 * The segment to append for a capture that has just stopped.
 *
 * `existing` is the file listing of the folder. Passing it is what stops a
 * half-written folder from being overwritten: a previous run that died between
 * writing mic-2.wav and writing meeting.json leaves a file the metadata does not
 * mention, and without the listing this would hand back that same name and the
 * audio would be lost. Names are compared case-insensitively, because MIC-2.WAV
 * and mic-2.wav are one file on the NTFS volumes this app ships to.
 *
 * `tracks` and `timeline` are accepted so the save path can build a whole
 * segment in one call; both default to null and are aggregated by withSegment.
 */
export function nextSegment(meta, opts = {}) {
  const { startedAt, endedAt, durationSeconds, existing, tracks, timeline } = isObj(opts) ? opts : {};

  const startMs = requireTime(startedAt, 'startedAt');
  const endMs = requireTime(endedAt, 'endedAt');
  if (endMs < startMs) throw fail('endedAt is before startedAt', 'BADTIME');

  const prior = segmentsOf(meta);
  const index = prior.length + 1;
  const anchorMs = meetingStartMs(meta, prior, startMs);

  let duration = num(durationSeconds);
  if (duration === null) duration = (endMs - startMs) / 1000;

  const taken = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter((f) => typeof f === 'string')
      .map((f) => f.toLowerCase())
  );
  // The pair moves together: a segment whose two tracks carry different numbers
  // would be a folder no one can read back by eye.
  let n = index;
  while (taken.has(wavName('mic', n)) || taken.has(wavName('system', n))) n++;

  return {
    index,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    durationSeconds: Math.max(0, round(duration, 2)),
    offsetSeconds: Math.max(0, round((startMs - anchorMs) / 1000, 2)),
    files: { mic: wavName('mic', n), system: wavName('system', n) },
    tracks: isObj(tracks) ? tracks : null,
    timeline: timeline ?? null,
    transcript: null,
  };
}

/* -------------------------------------------------------------- aggregation */

const TRACK_KEYS = ['mic', 'system'];

/** Fields that are quantities of a capture, so they add up across captures. */
const SUMMED_TRACK_FIELDS = ['samples', 'seconds', 'capturedSeconds', 'deficitSeconds', 'voicedSeconds'];

/**
 * One track's integrity across every segment.
 *
 * peak is the loudest moment anywhere, so it is a max. rms is an average, and
 * averaging averages would weight a four-second segment like a two-hour one, so
 * it is re-derived from the power of each segment weighted by that segment's
 * length. `silent` is the release gate for this whole subsystem, and it must
 * mean "this track never produced signal in this meeting", so one segment with
 * audio clears it.
 */
function aggregateTracks(segments) {
  const out = {};
  let found = false;

  for (const key of TRACK_KEYS) {
    const parts = segments.map((s) => (isObj(s.tracks) ? s.tracks[key] : null)).filter(isObj);
    if (!parts.length) continue;
    found = true;

    const track = {};
    for (const field of SUMMED_TRACK_FIELDS) {
      const values = parts.map((p) => num(p[field])).filter((v) => v !== null);
      if (values.length) track[field] = round(values.reduce((a, b) => a + b, 0), 3);
    }

    const peaks = parts.map((p) => num(p.peak)).filter((v) => v !== null);
    if (peaks.length) track.peak = Math.max(...peaks);

    const powered = parts
      .map((p) => ({
        rms: num(p.rms),
        weight: num(p.seconds) ?? num(p.capturedSeconds) ?? num(p.samples) ?? 1,
      }))
      .filter((p) => p.rms !== null && p.weight > 0);
    if (powered.length) {
      const total = powered.reduce((a, p) => a + p.weight, 0);
      const power = powered.reduce((a, p) => a + p.rms * p.rms * p.weight, 0);
      track.rms = round(Math.sqrt(power / total), 5);
    }

    const rates = parts.map((p) => num(p.sampleRate)).filter((v) => v !== null);
    // A resumed capture can reopen at a different rate. Claiming one number for
    // two would be a lie the wav headers would then contradict.
    if (rates.length) track.sampleRate = rates.every((r) => r === rates[0]) ? rates[0] : null;

    if (parts.some((p) => typeof p.silent === 'boolean')) {
      track.silent = parts.every((p) => p.silent === true);
    }

    out[key] = track;
  }

  return found ? out : null;
}

/**
 * Move one timeline entry onto the meeting clock.
 *
 * Two units live in these entries and both are the app's own: record.js writes
 * `at` in milliseconds since its capture started, transcribe.js writes `start`
 * and `end` in seconds. Shifting the wrong one by the wrong factor would put a
 * device-change marker a thousand segments away, so each is named explicitly and
 * anything else is copied through untouched.
 */
function shiftEntry(entry, offsetSeconds) {
  if (!isObj(entry)) return entry;
  const out = { ...entry };
  const at = num(entry.at);
  if (at !== null) out.at = Math.round(at + offsetSeconds * 1000);
  for (const field of ['start', 'end']) {
    const v = num(entry[field]);
    if (v !== null) out[field] = round(v + offsetSeconds, 3);
  }
  return out;
}

const entryTimeMs = (entry) => {
  if (!isObj(entry)) return 0;
  const at = num(entry.at);
  if (at !== null) return at;
  const start = num(entry.start);
  return start === null ? 0 : start * 1000;
};

/** Stable by construction: equal instants keep the order the segments gave them. */
const sortEntries = (entries) =>
  entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => entryTimeMs(a.e) - entryTimeMs(b.e) || a.i - b.i)
    .map((x) => x.e);

function sumNumberBag(bags) {
  const out = {};
  for (const bag of bags) {
    for (const [k, v] of Object.entries(bag)) {
      const n = num(v);
      if (n === null) out[k] = v;
      else out[k] = round((num(out[k]) ?? 0) + n, 3);
    }
  }
  return out;
}

/**
 * The meeting's timeline, in meeting time.
 *
 * record.js writes an object, `{ deviceEvents, mic: { renderBlocks, emptyBlocks },
 * system: {...} }`, so the merge preserves that shape rather than flattening it:
 * arrays concatenate and re-sort, block counts add, and a plain array timeline
 * (what transcribe.js style callers hand over) concatenates and re-sorts too.
 * Whatever shape went in, meta.timeline keeps it, because record.js and the
 * library read it back by name.
 */
function aggregateTimeline(segments) {
  const parts = segments
    .map((s) => ({ tl: s.timeline, offset: Math.max(0, num(s.offsetSeconds) ?? 0) }))
    .filter((p) => p.tl != null);
  if (!parts.length) return null;

  if (parts.every((p) => Array.isArray(p.tl))) {
    return sortEntries(parts.flatMap((p) => p.tl.map((e) => shiftEntry(e, p.offset))));
  }

  const objects = parts.filter((p) => isObj(p.tl));
  if (!objects.length) return parts[parts.length - 1].tl;

  const out = {};
  const keys = [];
  for (const p of objects) for (const k of Object.keys(p.tl)) if (!keys.includes(k)) keys.push(k);

  for (const key of keys) {
    const values = objects.map((p) => ({ v: p.tl[key], offset: p.offset })).filter((x) => x.v != null);
    if (!values.length) continue;

    if (values.some((x) => Array.isArray(x.v))) {
      out[key] = sortEntries(
        values.flatMap((x) => (Array.isArray(x.v) ? x.v.map((e) => shiftEntry(e, x.offset)) : []))
      );
    } else if (values.every((x) => num(x.v) !== null)) {
      out[key] = round(values.reduce((a, x) => a + x.v, 0), 3);
    } else if (values.every((x) => isObj(x.v))) {
      out[key] = sumNumberBag(values.map((x) => x.v));
    } else {
      out[key] = values[values.length - 1].v;
    }
  }
  return out;
}

/**
 * How much audio one segment carries.
 *
 * The declared number wins, because it is what the encoder actually wrote. When
 * it is missing or is not a number, the two instants are measured instead rather
 * than the segment being counted as zero: durationSeconds is the figure the
 * library shows and the realtime factor is divided by, so silently dropping a
 * ten minute capture out of it would report the meeting as half its length.
 * segmentsOf already falls back this way for a schema-1 read; this is the same
 * rule applied to a stored segment.
 */
function segmentSeconds(segment) {
  const declared = num(segment.durationSeconds);
  if (declared !== null) return Math.max(0, declared);
  const startMs = toMs(segment.startedAt);
  const endMs = toMs(segment.endedAt);
  if (startMs === null || endMs === null) return 0;
  return Math.max(0, (endMs - startMs) / 1000);
}

/**
 * meta with one more segment on it, as a NEW object.
 *
 * Never mutates: the caller usually still holds the parsed meeting.json it read
 * from disk, and a failed write must leave that copy describing what is actually
 * in the folder.
 */
export function withSegment(meta, segment) {
  if (!isObj(segment)) throw fail('withSegment needs a segment object', 'BADSEGMENT');

  const base = isObj(meta) ? meta : {};
  const segments = segmentsOf(base).concat([segment]);

  const starts = segments.map((s) => toMs(s.startedAt)).filter((v) => v !== null);
  const ends = segments.map((s) => toMs(s.endedAt)).filter((v) => v !== null);
  // The earliest instant anyone can name, not whatever sits in the first array
  // slot. A segment whose clock did not survive the read leaves a hole, and a
  // segments array that is out of order would otherwise put the start of the
  // meeting halfway through it. The meta's own startedAt counts as evidence too,
  // so a resumed meeting never loses the start it already had.
  const declaredStart = toMs(base.startedAt);
  const anchors = declaredStart !== null ? starts.concat([declaredStart]) : starts;
  const firstStart = anchors.length ? Math.min(...anchors) : null;
  const lastEnd = ends.length ? Math.max(...ends) : null;

  const durationSeconds = round(
    segments.reduce((total, s) => total + segmentSeconds(s), 0),
    2
  );

  return {
    ...base,
    schema: 2,
    segments,
    // Both instants are recomputed, and for the same reason: library.js sorts the
    // home list by startedAt and shows nothing without it, and the MCP listing
    // formats it. Deriving endedAt while leaving startedAt to whatever the base
    // happened to carry loses it outright on the first segment of a meeting
    // assembled here rather than by the schema-1 save path.
    // Kept as an ISO string, which is the only form schema 1 ever wrote and the
    // only one library.js and the MCP server format for display.
    startedAt: firstStart !== null ? new Date(firstStart).toISOString() : (base.startedAt ?? null),
    endedAt: lastEnd !== null ? new Date(lastEnd).toISOString() : (base.endedAt ?? null),
    durationSeconds,
    // With no readable clock there is no wall window to measure, and captured
    // time is the only honest floor for it.
    spanSeconds:
      firstStart !== null && lastEnd !== null
        ? Math.max(0, round((lastEnd - firstStart) / 1000, 2))
        : durationSeconds,
    tracks: aggregateTracks(segments) ?? base.tracks ?? null,
    timeline: aggregateTimeline(segments) ?? base.timeline ?? null,
  };
}

/* ---------------------------------------------------------------- transcript */

/**
 * Where a segment's samples begin in the meeting, for anything that has to seek
 * in PCM rather than in text. Non-finite in, zero out: a NaN sample index thrown
 * at a Float32Array subarray is silent nonsense rather than an error.
 */
export function offsetSamples(seconds, sampleRate = 16000) {
  const s = num(seconds);
  const r = num(sampleRate);
  if (s === null || r === null) return 0;
  return Math.round(s * r);
}

/**
 * The worker results for one segment, moved onto the meeting clock.
 *
 * The ASR sees one wav and times everything from ITS zero, so segment 2's first
 * word comes back at 0.4s. buildTranscript then sorts by start and folds
 * consecutive turns, so feeding it two segments unshifted would interleave the
 * second half of the meeting into the first. Shift before buildTranscript, never
 * after: fixing timestamps in the rendered markdown cannot undo a fold that
 * already merged two speakers' turns.
 */
export function shiftResults(results, offsetSeconds) {
  if (!Array.isArray(results)) return [];
  const offset = num(offsetSeconds) ?? 0;

  return results.map((r) => {
    if (!isObj(r)) return r;
    if (!Array.isArray(r.segments)) return { ...r };
    return {
      ...r,
      segments: r.segments.map((s) => {
        if (!isObj(s)) return s;
        const start = num(s.start);
        const end = num(s.end);
        return {
          ...s,
          start: start === null ? s.start : round(start + offset, 3),
          end: end === null ? s.end : round(end + offset, 3),
        };
      }),
    };
  });
}

/**
 * One transcript line and everything hanging off it.
 *
 * Hours are open-ended rather than exactly two digits: hhmmss in transcribe.js
 * pads to two but does not cap, and a meeting left recording overnight writes
 * [100:00:00]. Only "You" and "Them" exist, by construction of the two tracks.
 */
const ENTRY_LINE = /^\[(\d+):(\d{1,2}):(\d{1,2})\]\s+(You|Them):/;

/**
 * Continuation lines belong to the entry above them. A model's text can contain
 * a newline, and a line that does not start with a timestamp is not a turn of
 * its own, so attaching it to the entry above is what keeps the reordering below
 * from tearing a paragraph away from its speaker.
 */
function parseBody(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const preamble = [];
  const entries = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(ENTRY_LINE);
    if (m) {
      current = {
        seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
        lines: [line],
      };
      entries.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  const trimTail = (arr) => {
    const out = arr.slice();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };

  return {
    preamble: trimTail(preamble),
    entries: entries.map((e) => {
      const block = trimTail(e.lines).join('\n');
      return {
        seconds: e.seconds,
        block,
        // Whitespace is not evidence of a different line. Two runs of the same
        // ASR output that differ only in spacing are the same utterance.
        key: block.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n'),
      };
    }),
  };
}

/**
 * Merge two transcript.md bodies into one ordered body.
 *
 * A pure string function, so it can run before anything is written and the
 * caller can decide what to do with the result. The merge is by timestamp rather
 * than by append, because a segment can be transcribed out of order: a retry of
 * segment 1 lands after segment 2 is already on disk.
 */
export function appendTranscript(existing, added) {
  const left = parseBody(existing);
  const right = parseBody(added);

  const same = (a, b) => a.join('\n').trim() === b.join('\n').trim();
  const preamble = left.preamble.length && right.preamble.length && same(left.preamble, right.preamble)
    ? left.preamble
    : left.preamble.concat(right.preamble);

  // Only the incoming side is de-duplicated. Two genuinely identical lines
  // already in transcript.md are the user's file, and normalising x must not
  // quietly delete half of them.
  const seen = new Set(left.entries.map((e) => e.key));
  const merged = left.entries.concat(right.entries.filter((e) => !seen.has(e.key)));

  const ordered = merged
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.seconds - b.e.seconds || a.i - b.i)
    .map((x) => x.e.block);

  const parts = preamble.length ? preamble.concat(ordered.length ? [''] : []) : [];
  const body = parts.concat(ordered).join('\n');
  return body.trim() ? `${body.replace(/\s+$/, '')}\n` : '';
}
