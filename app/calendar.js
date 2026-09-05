/**
 * MIN · calendar, a self-contained ICS reader.
 *
 * Two jobs, and only two. Give the home screen a list of what is coming up, and
 * tell the recorder which meeting is happening at a given instant so a recording
 * can title itself. Everything here is in service of those two.
 *
 * Why a hand-written parser rather than a dependency: the project ships an
 * unsigned installer with no auto-update, so every dependency is a supply-chain
 * risk the user cannot be patched out of. An ICS feed is also attacker-influenced
 * text (anyone who can put an event on the user's calendar controls it), which is
 * a poor place to point a parser nobody in this repo has read.
 *
 * Why a secret ICS URL rather than OAuth: OAuth needs a registered client, a
 * consent screen, and a redirect target, which means a server somebody operates.
 * That breaks the zero-recurring-cost constraint. A pasted secret URL works with
 * Google, Outlook, iCloud and Fastmail alike and needs nothing running anywhere.
 *
 * The secret URL is a bearer credential. Nothing here ever puts a full calendar
 * URL into an error string, because those strings end up in the UI and in logs.
 *
 * No console output: this is imported by both the main process and the renderer.
 */

/* --------------------------------------------------------------- constants */

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

/**
 * Wider than any real UTC offset (the extremes are +14:00 and -12:00), used to
 * bound wall clock against instants without doing the conversion.
 */
const OFFSET_BOUND_MS = 26 * 3600000;

/** Occurrences produced by one RRULE. A malformed rule must not be able to hang the UI. */
const MAX_OCCURRENCES = 500;

/**
 * Periods walked while looking for those occurrences. A rule can legitimately
 * skip periods (FREQ=MONTHLY;BYMONTHDAY=31 misses five months a year), so the
 * period budget has to be much larger than the occurrence budget. 20,000 days is
 * about 54 years, past which a personal calendar is not the problem.
 */
const MAX_PERIODS = 20000;

/** Generous for a calendar: a year of a busy Google feed is well under 1 MB. */
const MAX_FEED_BYTES = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 15000;

/** Windows refuses these as file or folder names, with or without an extension. */
const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/* ------------------------------------------------------------ text hygiene */

/**
 * Every string that leaves this module has been through here. Control characters
 * would corrupt a markdown file, and the bidi overrides are the classic filename
 * spoof (U+202E turns "photo_gnp.exe" into something that reads as a png).
 */
function cleanText(value, cap = 500) {
  if (typeof value !== 'string') return '';
  let out = value
    .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ' '))
    .replace(/\p{Cf}/gu, '');
  // Newlines survive in descriptions, so collapse only the horizontal runs there.
  out = out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return out.length > cap ? out.slice(0, cap).trim() : out;
}

/** RFC 5545 3.3.11. Order matters: a lone backslash must not eat the next escape. */
function unescapeText(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== '\\') { out += c; continue; }
    const next = value[++i];
    if (next === undefined) { out += '\\'; break; }
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === ',' || next === ';' || next === '\\') out += next;
    else out += next; // Unknown escape: the spec says invalid, the useful thing is the character
  }
  return out;
}

/* ---------------------------------------------------------------- time zones */

const zoneFormatters = new Map();

function zoneFormatter(timeZone) {
  let f = zoneFormatters.get(timeZone);
  if (f) return f;
  // Throws RangeError on a zone Intl does not know, which is how unknown TZIDs are detected.
  f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  zoneFormatters.set(timeZone, f);
  return f;
}

/**
 * The offset a named zone was at, at a given instant, in milliseconds.
 *
 * The trick, and the reason no tzdata dependency is needed: format the instant in
 * the target zone, then read those wall-clock digits back as if they were UTC.
 * The gap between that and the real instant IS the offset, because Intl already
 * carries the full IANA database including every historical DST rule.
 */
function zoneOffsetMs(timeZone, instantMs) {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instantMs));
  const got = {};
  for (const p of parts) if (p.type !== 'literal') got[p.type] = Number(p.value);
  const asIfUTC = Date.UTC(got.year, got.month - 1, got.day, got.hour % 24, got.minute, got.second);
  return asIfUTC - instantMs;
}

/**
 * Wall-clock time in a named zone to a real instant.
 *
 * Two passes, because the offset depends on the instant and the instant is what
 * is being solved for. The first guess uses the wall time as a stand-in instant,
 * which is wrong by at most one offset, so the second pass lands on the answer
 * everywhere except the two hours a year DST moves.
 *
 * Those two hours: a wall time in the spring-forward gap does not exist, and the
 * refinement will not be self-consistent, so the first guess is kept and the
 * result reads as the hour after the gap, which is what every calendar UI shows.
 * A wall time in the autumn fall-back hour happens twice, and this returns the
 * first (still-daylight) one, matching Google and Apple.
 */
function zonedWallToInstant(wallMs, timeZone) {
  const offset1 = zoneOffsetMs(timeZone, wallMs);
  let candidate = wallMs - offset1;
  const offset2 = zoneOffsetMs(timeZone, candidate);
  if (offset2 !== offset1) {
    const refined = wallMs - offset2;
    if (zoneOffsetMs(timeZone, refined) === offset2) candidate = refined;
  }
  return candidate;
}

/** Wall clock as a pseudo-UTC timestamp, which is where all recurrence maths happens. */
function wallOf(y, mo, d, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/**
 * Pseudo-UTC wall clock back to a real instant, per the event's zone.
 *
 * Recurrence is defined on wall time, not on elapsed time: a class at 11:05 stays
 * at 11:05 after the clocks change. So expansion runs entirely in pseudo-UTC,
 * where day and week arithmetic is exact, and only the final conversion knows
 * about zones.
 */
function wallToInstant(wallMs, tzid) {
  if (!tzid) {
    // Floating (and all-day): the spec says these mean "whatever the clock on the
    // wall says", so they follow the machine, not any fixed zone.
    const d = new Date(wallMs);
    return new Date(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
    ).getTime();
  }
  if (tzid === 'UTC') return wallMs;
  return zonedWallToInstant(wallMs, tzid);
}

/* ------------------------------------------------------------- line parsing */

/**
 * Unfold, per RFC 5545 3.1: a line break followed by a space or tab is a
 * continuation, and both characters vanish. Google folds at 75 octets, so this
 * fires on nearly every real feed, and skipping it splits long summaries in half.
 */
function unfold(text) {
  return String(text).replace(/\r\n[ \t]|[\r\n][ \t]/g, '');
}

/**
 * Split a content line into name, params and value.
 *
 * Written as a scanner rather than a regex because a quoted parameter may contain
 * a colon (CN="Smith: Jane" is legal), and a regex that stops at the first colon
 * silently mangles those lines.
 */
function parseLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const segments = [];
  let current = '';
  let quoted = false;
  for (const c of head) {
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ';' && !quoted) { segments.push(current); current = ''; continue; }
    current += c;
  }
  segments.push(current);

  const name = segments[0].trim().toUpperCase();
  const params = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf('=');
    if (eq < 0) continue;
    params[segments[i].slice(0, eq).trim().toUpperCase()] = segments[i].slice(eq + 1).trim();
  }
  return { name, params, value };
}

/* -------------------------------------------------------------- date values */

const DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * One DTSTART/DTEND/EXDATE/RECURRENCE-ID value.
 *
 * Three forms exist in the wild and all three turn up in one Google feed: UTC
 * ("...Z"), floating local, and DATE-only for all-day events. A fourth, TZID with
 * a named zone, is what Google actually emits for anything the user created.
 */
function parseDateValue(rawValue, params = {}) {
  const value = String(rawValue || '').trim();
  const m = DATE_RE.exec(value);
  if (!m) return null;

  const [, y, mo, d, h, mi, s, z] = m;
  const dateOnly = params.VALUE === 'DATE' || h === undefined;
  const wallMs = wallOf(+y, +mo, +d, +(h || 0), +(mi || 0), +(s || 0));

  let tzid = null;
  let tzUnknown = false;
  if (dateOnly) {
    tzid = null; // An all-day event is the same day everywhere, so it floats.
  } else if (z) {
    tzid = 'UTC';
  } else if (params.TZID) {
    const wanted = params.TZID.replace(/^"|"$/g, '');
    try {
      zoneFormatter(wanted);
      tzid = wanted;
    } catch {
      // Outlook sometimes sends Windows zone names ("Eastern Standard Time").
      // Falling back to floating keeps the wall time right for a user in that
      // zone rather than dropping the event, and the flag lets the UI say so.
      tzid = null;
      tzUnknown = true;
    }
  }

  return { wallMs, tzid, allDay: dateOnly, tzUnknown, instantMs: wallToInstant(wallMs, tzid) };
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

function parseDuration(value) {
  const m = DURATION_RE.exec(String(value || '').trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = (+(w || 0) * 7 + +(d || 0)) * DAY_MS
    + +(h || 0) * 3600000 + +(mi || 0) * 60000 + +(s || 0) * 1000;
  return sign === '-' ? -ms : ms;
}

/* ------------------------------------------------------------------- RRULE */

const RRULE_SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/**
 * Parts that change which dates a rule produces and that this expander does not
 * implement. Meeting one of these is a correctness problem, not a cosmetic one,
 * so the event is emitted once and flagged rather than expanded wrongly. A wrong
 * date on the home screen is worse than a missing repeat.
 */
const RRULE_UNIMPLEMENTED = ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYMONTH'];

function parseRRule(text) {
  const parts = {};
  for (const chunk of String(text || '').split(';')) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    parts[chunk.slice(0, eq).trim().toUpperCase()] = chunk.slice(eq + 1).trim();
  }
  if (!parts.FREQ) return null;

  const rule = {
    freq: parts.FREQ.toUpperCase(),
    interval: Math.max(1, parseInt(parts.INTERVAL, 10) || 1),
    count: parts.COUNT ? Math.max(0, parseInt(parts.COUNT, 10) || 0) : null,
    untilRaw: parts.UNTIL || null,
    byDay: null,
    byMonthDay: null,
    wkst: WEEKDAYS[(parts.WKST || 'MO').toUpperCase()] ?? 1,
    unsupported: null,
  };

  if (parts.BYDAY) {
    rule.byDay = [];
    for (const token of parts.BYDAY.split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
      if (!m) { rule.unsupported = `BYDAY=${token.trim()}`; break; }
      rule.byDay.push({ nth: m[1] ? parseInt(m[1], 10) : null, dow: WEEKDAYS[m[2].toUpperCase()] });
    }
    if (!rule.byDay?.length) rule.byDay = null;
  }

  if (parts.BYMONTHDAY) {
    rule.byMonthDay = parts.BYMONTHDAY.split(',')
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => Number.isInteger(n) && n !== 0 && n >= -31 && n <= 31);
    if (!rule.byMonthDay.length) rule.byMonthDay = null;
  }

  if (!rule.unsupported) {
    if (!RRULE_SUPPORTED_FREQ.has(rule.freq)) rule.unsupported = `FREQ=${rule.freq}`;
    else {
      for (const part of RRULE_UNIMPLEMENTED) {
        if (parts[part]) { rule.unsupported = part; break; }
      }
      // Yearly is handled as a plain anniversary of DTSTART. Anything that moves
      // the date within the year is out of scope.
      if (!rule.unsupported && rule.freq === 'YEARLY' && (rule.byDay || rule.byMonthDay)) {
        rule.unsupported = 'YEARLY with BYDAY or BYMONTHDAY';
      }
    }
  }
  return rule;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function floorToWallDay(wallMs) {
  return Math.floor(wallMs / DAY_MS) * DAY_MS;
}

/** Which days of a month a MONTHLY BYDAY selects, including the nth forms like 2TH and -1FR. */
function monthDaysForByDay(year, monthIndex, byDay) {
  const total = daysInMonth(year, monthIndex);
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const picked = new Set();
  for (const { nth, dow } of byDay) {
    const matches = [];
    let day = 1 + ((dow - firstDow + 7) % 7);
    for (; day <= total; day += 7) matches.push(day);
    if (nth === null) for (const d of matches) picked.add(d);
    else {
      const chosen = nth > 0 ? matches[nth - 1] : matches[matches.length + nth];
      if (chosen) picked.add(chosen);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------- parse */

function buildEvent(props) {
  const first = (name) => props.find((p) => p.name === name);
  const all = (name) => props.filter((p) => p.name === name);
  const textOf = (name, cap) => {
    const p = first(name);
    return p ? cleanText(unescapeText(p.value), cap) : '';
  };

  const dtstartProp = first('DTSTART');
  const start = dtstartProp ? parseDateValue(dtstartProp.value, dtstartProp.params) : null;
  if (!start) return null; // A VEVENT with no usable DTSTART cannot be placed on an agenda.

  const dtendProp = first('DTEND');
  let endWallMs;
  if (dtendProp) {
    const end = parseDateValue(dtendProp.value, dtendProp.params);
    endWallMs = end ? end.wallMs : null;
  }
  if (endWallMs == null) {
    const durProp = first('DURATION');
    const dur = durProp ? parseDuration(durProp.value) : null;
    if (dur != null) endWallMs = start.wallMs + dur;
  }
  if (endWallMs == null) {
    // RFC 5545 3.6.1: a DATE start with no end lasts one day, a DATE-TIME start
    // with no end is instantaneous.
    endWallMs = start.allDay ? start.wallMs + DAY_MS : start.wallMs;
  }
  if (endWallMs < start.wallMs) endWallMs = start.wallMs;

  const attendees = all('ATTENDEE').map((p) => ({
    email: cleanText(p.value.replace(/^mailto:/i, ''), 254).toLowerCase(),
    name: cleanText(unescapeText(p.params.CN || ''), 120),
    partstat: (p.params.PARTSTAT || '').toUpperCase() || null,
    role: (p.params.ROLE || '').toUpperCase() || null,
    optional: (p.params.ROLE || '').toUpperCase() === 'OPT-PARTICIPANT',
  }));

  const organizerProp = first('ORGANIZER');
  const organizer = organizerProp
    ? {
        email: cleanText(organizerProp.value.replace(/^mailto:/i, ''), 254).toLowerCase(),
        name: cleanText(unescapeText(organizerProp.params.CN || ''), 120),
      }
    : null;

  // EXDATE is meant to carry the same value type and zone as DTSTART, and Apple
  // and Outlook both ship feeds where it does not. Reading a bare EXDATE in the
  // event's own zone is the only interpretation that excludes the day the user
  // deleted, and it means exclusions are compared as instants and nothing else.
  const exdates = [];
  for (const p of all('EXDATE')) {
    const bare = !p.params.TZID && !/Z$/.test(p.value.split(',')[0].trim());
    const params = bare && start.tzid ? { ...p.params, TZID: start.tzid } : p.params;
    for (const piece of p.value.split(',')) {
      const parsed = parseDateValue(piece, params);
      if (parsed) exdates.push(parsed);
    }
  }

  const recurrenceProp = first('RECURRENCE-ID');
  const recurrence = recurrenceProp ? parseDateValue(recurrenceProp.value, recurrenceProp.params) : null;

  const rruleProp = first('RRULE');
  const rrule = rruleProp ? parseRRule(rruleProp.value) : null;

  const uidProp = first('UID');
  const uid = uidProp ? cleanText(unescapeText(uidProp.value), 512) : '';

  return {
    uid: uid || `no-uid-${start.wallMs}-${textOf('SUMMARY', 60)}`,
    summary: textOf('SUMMARY', 500),
    description: textOf('DESCRIPTION', 4000),
    location: textOf('LOCATION', 500),
    status: (first('STATUS')?.value || '').trim().toUpperCase() || null,
    sequence: parseInt(first('SEQUENCE')?.value ?? '', 10) || 0,
    transparency: (first('TRANSP')?.value || '').trim().toUpperCase() || null,
    organizer,
    attendees,

    start: new Date(start.instantMs),
    end: new Date(wallToInstant(endWallMs, start.tzid)),
    allDay: start.allDay,
    tzid: start.tzid,
    tzUnknown: start.tzUnknown,

    rrule: rruleProp ? rruleProp.value.trim() : null,
    rruleParts: rrule,
    rruleUnsupported: Boolean(rrule?.unsupported),
    rruleUnsupportedReason: rrule?.unsupported || null,
    exdates: exdates.map((e) => ({ instantMs: e.instantMs, wallMs: e.wallMs })),
    recurrenceId: recurrence ? new Date(recurrence.instantMs) : null,
    overrides: [],

    // Wall clock is the basis for every recurrence calculation, see wallToInstant.
    startWallMs: start.wallMs,
    endWallMs,
  };
}

/**
 * Attach RECURRENCE-ID events to their master so expansion can swap them in.
 *
 * A modified instance ("this week's standup moved to 3pm") arrives as a separate
 * VEVENT sharing the master's UID. Left unlinked it shows up as a duplicate
 * alongside the occurrence it was supposed to replace.
 */
function linkOverrides(events) {
  const masters = new Map();
  for (const ev of events) if (!ev.recurrenceId) masters.set(ev.uid, ev);
  for (const ev of events) {
    if (!ev.recurrenceId) continue;
    const master = masters.get(ev.uid);
    if (master) master.overrides.push(ev);
  }
  return events;
}

/**
 * Parse an ICS document into events.
 *
 * Anything that is not a VEVENT is skipped by tracking component nesting, which
 * matters more than it sounds: VTIMEZONE and VALARM both contain DTSTART, and a
 * flat line-by-line parser happily reads a VALARM trigger as the meeting time.
 */
export function parseICS(text) {
  if (typeof text !== 'string' || !text) return [];

  const lines = unfold(text).split(/\r\n|\n|\r/);
  const stack = [];
  const events = [];
  let current = null;

  for (const raw of lines) {
    if (!raw) continue;
    const parsed = parseLine(raw);
    if (!parsed) continue;

    if (parsed.name === 'BEGIN') {
      const component = parsed.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VEVENT' && !current) current = [];
      continue;
    }
    if (parsed.name === 'END') {
      const component = parsed.value.trim().toUpperCase();
      if (stack[stack.length - 1] === component) stack.pop();
      else if (stack.includes(component)) while (stack.length && stack.pop() !== component) { /* resync */ }
      if (component === 'VEVENT' && current) {
        const built = buildEvent(current);
        if (built) events.push(built);
        current = null;
      }
      continue;
    }

    // Only properties whose innermost component is the VEVENT itself. This is
    // what keeps a VALARM's own DTSTART out of the meeting.
    if (current && stack[stack.length - 1] === 'VEVENT') current.push(parsed);
  }

  return linkOverrides(events);
}

/* --------------------------------------------------------------- expansion */

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isNaN(t) ? NaN : t; }
  return NaN;
}

function occurrenceOf(event, startWallMs, endWallMs) {
  const startMs = wallToInstant(startWallMs, event.tzid);
  const endMs = wallToInstant(endWallMs, event.tzid);
  return {
    ...event,
    start: new Date(startMs),
    end: new Date(endMs),
    startWallMs,
    endWallMs,
    isRecurrence: true,
    recurrenceStart: new Date(startMs),
    overrides: [],
  };
}

/** UNTIL is an instant (usually UTC). A DATE-only UNTIL covers the whole of that day. */
function untilInstant(rule, event) {
  if (!rule.untilRaw) return null;
  const parsed = parseDateValue(rule.untilRaw, {});
  if (!parsed) return null;
  if (parsed.allDay) return wallToInstant(parsed.wallMs + DAY_MS - 1, event.tzid);
  return parsed.instantMs;
}

/** Candidate wall-clock starts in chronological order, before COUNT/UNTIL/EXDATE. */
function* candidateWalls(event, rule) {
  const startWall = event.startWallMs;
  const timeOfDay = startWall - floorToWallDay(startWall);
  const base = new Date(startWall);

  if (rule.freq === 'DAILY') {
    for (let p = 0; p < MAX_PERIODS; p++) {
      const ms = startWall + p * rule.interval * DAY_MS;
      const dow = new Date(ms).getUTCDay();
      if (rule.byDay && !rule.byDay.some((b) => b.dow === dow)) continue;
      if (rule.byMonthDay) {
        const d = new Date(ms);
        const total = daysInMonth(d.getUTCFullYear(), d.getUTCMonth());
        const wanted = rule.byMonthDay.map((n) => (n > 0 ? n : total + n + 1));
        if (!wanted.includes(d.getUTCDate())) continue;
      }
      yield ms;
    }
    return;
  }

  if (rule.freq === 'WEEKLY') {
    const dows = rule.byDay ? [...new Set(rule.byDay.map((b) => b.dow))] : [base.getUTCDay()];
    // Sort by position within the week so occurrences come out in order, which
    // COUNT depends on. WKST decides where the week begins, and it is load-bearing
    // for INTERVAL >= 2: it decides which days fall in the same skipped week.
    const ordered = dows
      .map((dow) => ({ dow, offset: (dow - rule.wkst + 7) % 7 }))
      .sort((a, b) => a.offset - b.offset);
    const weekAnchor = floorToWallDay(startWall) - ((base.getUTCDay() - rule.wkst + 7) % 7) * DAY_MS;

    for (let p = 0; p < MAX_PERIODS; p++) {
      const weekStart = weekAnchor + p * rule.interval * 7 * DAY_MS;
      for (const { offset } of ordered) {
        const ms = weekStart + offset * DAY_MS + timeOfDay;
        if (ms < startWall) continue; // Nothing before DTSTART is in the set
        yield ms;
      }
    }
    return;
  }

  if (rule.freq === 'MONTHLY') {
    const baseYear = base.getUTCFullYear();
    const baseMonth = base.getUTCMonth();
    for (let p = 0; p < MAX_PERIODS; p++) {
      const absolute = baseMonth + p * rule.interval;
      const year = baseYear + Math.floor(absolute / 12);
      const month = ((absolute % 12) + 12) % 12;
      const total = daysInMonth(year, month);

      let days;
      if (rule.byDay) days = monthDaysForByDay(year, month, rule.byDay);
      else if (rule.byMonthDay) {
        days = [...new Set(rule.byMonthDay.map((n) => (n > 0 ? n : total + n + 1)))]
          .filter((d) => d >= 1 && d <= total).sort((a, b) => a - b);
      } else {
        // A rule anchored on the 31st simply skips short months, per the spec.
        days = base.getUTCDate() <= total ? [base.getUTCDate()] : [];
      }

      for (const d of days) {
        const ms = Date.UTC(year, month, d) + timeOfDay;
        if (ms < startWall) continue;
        yield ms;
      }
    }
    return;
  }

  if (rule.freq === 'YEARLY') {
    const month = base.getUTCMonth();
    const day = base.getUTCDate();
    for (let p = 0; p < MAX_PERIODS; p++) {
      const year = base.getUTCFullYear() + p * rule.interval;
      if (day > daysInMonth(year, month)) continue; // 29 February in a common year
      yield Date.UTC(year, month, day) + timeOfDay;
    }
  }
}

/**
 * Concrete occurrences of one event that overlap [rangeStart, rangeEnd).
 *
 * An event with no RRULE, or with one this cannot expand, yields itself once, so
 * the caller never has to special-case the difference.
 */
export function expandRecurring(event, rangeStart, rangeEnd) {
  // Anything that is not a parsed event is dropped rather than allowed to throw,
  // so a single bad entry cannot take the whole agenda down with it.
  if (!event || !(event.start instanceof Date) || !(event.end instanceof Date)) return [];
  if (!Array.isArray(event.attendees) || !Array.isArray(event.exdates)) return [];
  const fromMs = toMs(rangeStart);
  const toMsEnd = toMs(rangeEnd);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMsEnd)) return [];

  const overlaps = (startMs, endMs) => startMs < toMsEnd && (endMs > fromMs || endMs === startMs);
  const rule = event.rruleParts;

  if (!rule || rule.unsupported) {
    const startMs = event.start.getTime();
    const endMs = event.end.getTime();
    return overlaps(startMs, endMs) ? [{ ...event, isRecurrence: false }] : [];
  }

  const until = untilInstant(rule, event);
  const durationWall = event.endWallMs - event.startWallMs;
  const excluded = new Set(event.exdates.map((e) => e.instantMs));
  const overrideByInstant = new Map();
  for (const o of event.overrides) {
    if (o.recurrenceId) overrideByInstant.set(o.recurrenceId.getTime(), o);
  }

  const out = [];
  let emitted = 0;

  for (const wallMs of candidateWalls(event, rule)) {
    if (rule.count !== null && emitted >= rule.count) break;

    // Wall-space bounds first, because turning a wall time into an instant costs
    // an Intl format and a rule that started years ago has thousands of
    // occurrences nobody is asking about. OFFSET_BOUND_MS is wider than any real
    // zone offset, so a candidate outside the padded window cannot be inside the
    // real one whatever the conversion turns out to be.
    if (wallMs - OFFSET_BOUND_MS >= toMsEnd) break;

    // An excluded or overridden date still consumes a COUNT slot: COUNT bounds the
    // rule's output, and EXDATE removes from that output afterwards.
    emitted++;
    if (wallMs + durationWall + OFFSET_BOUND_MS < fromMs) continue;

    const startMs = wallToInstant(wallMs, event.tzid);
    if (until !== null && startMs > until) break;
    if (startMs >= toMsEnd) break;

    const override = overrideByInstant.get(startMs);
    if (override) {
      const oStart = override.start.getTime();
      const oEnd = override.end.getTime();
      if (overlaps(oStart, oEnd)) out.push({ ...override, isRecurrence: true, isOverride: true, overrides: [] });
    } else if (!excluded.has(startMs)) {
      const endMs = wallToInstant(wallMs + durationWall, event.tzid);
      if (overlaps(startMs, endMs)) out.push(occurrenceOf(event, wallMs, wallMs + durationWall));
    }

    if (out.length >= MAX_OCCURRENCES) break;
  }

  return out;
}

/**
 * Expand a whole feed over a window.
 *
 * Override VEVENTs are skipped here when their master is present, because
 * expandRecurring has already substituted them into the series. An orphan
 * override (master outside the feed's window) is kept, otherwise a real meeting
 * would vanish.
 */
export function expandAll(events, rangeStart, rangeEnd) {
  const list = Array.isArray(events) ? events : [];
  const mastersWithRule = new Set();
  for (const ev of list) {
    if (ev && !ev.recurrenceId && ev.rruleParts && !ev.rruleParts.unsupported) mastersWithRule.add(ev.uid);
  }

  const out = [];
  for (const ev of list) {
    if (!ev) continue;
    if (ev.recurrenceId && mastersWithRule.has(ev.uid)) continue;
    for (const occ of expandRecurring(ev, rangeStart, rangeEnd)) out.push(occ);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/* ------------------------------------------------------------------ agenda */

/** FNV-1a. A hash, not the raw UID, because the UID ends up in DOM attributes. */
function stableId(uid, startMs) {
  const s = `${uid}|${startMs}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `ev_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The shape the home screen renders. Nothing here is raw feed text. */
function toAgendaEvent(occ, nowMs) {
  const startMs = occ.start.getTime();
  const endMs = occ.end.getTime();
  return {
    id: stableId(occ.uid, startMs),
    uid: occ.uid,
    title: occ.summary || 'Untitled event',
    start: occ.start,
    end: occ.end,
    allDay: Boolean(occ.allDay),
    location: occ.location || '',
    attendeeCount: occ.attendees.length,
    status: occ.status,
    organizer: occ.organizer ? (occ.organizer.name || occ.organizer.email) : '',
    recurring: Boolean(occ.rrule),
    unexpandedRule: Boolean(occ.rruleUnsupported),
    inProgress: startMs <= nowMs && endMs > nowMs,
  };
}

/**
 * The agenda: everything from `from` to `days` local days later, grouped by the
 * day it lands on.
 *
 * Meetings in progress are included even though they started before `from`,
 * because "what am I in right now" is the single most useful line on the screen.
 * Cancelled events are dropped: they are noise, and a cancelled meeting is not
 * one to record.
 */
export function upcoming(events, options = {}) {
  const { from = new Date(), days = 7 } = options || {};
  const fromMs = Number.isFinite(toMs(from)) ? toMs(from) : Date.now();
  const span = Math.max(1, Math.min(370, Math.floor(days) || 1));
  const windowEndMs = startOfLocalDay(fromMs) + span * DAY_MS;

  const occurrences = expandAll(events, new Date(fromMs), new Date(windowEndMs))
    .filter((occ) => occ.status !== 'CANCELLED');

  const groups = new Map();
  for (const occ of occurrences) {
    const key = localDayKey(occ.start);
    if (!groups.has(key)) groups.set(key, { date: key, label: '', events: [] });
    groups.get(key).events.push(toAgendaEvent(occ, fromMs));
  }

  const todayKey = localDayKey(new Date(fromMs));
  const tomorrowKey = localDayKey(new Date(startOfLocalDay(fromMs) + DAY_MS));

  const out = [...groups.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const group of out) {
    // All-day items sit above timed ones, the way every calendar UI shows them.
    group.events.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      if (a.start - b.start !== 0) return a.start - b.start;
      return a.title.localeCompare(b.title);
    });
    const [y, m, d] = group.date.split('-').map(Number);
    const asDate = new Date(y, m - 1, d);
    group.label = group.date === todayKey ? 'Today'
      : group.date === tomorrowKey ? 'Tomorrow'
        : asDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }
  return out;
}

/* ------------------------------------------------------- what is on now */

/**
 * Did the user decline this?
 *
 * A personal ICS feed does not say which ATTENDEE is the user, so pass selfEmail
 * when it is known. Without it, the only safe reading is that an event where
 * every single attendee declined is dead, and anything else might be live.
 */
function isDeclined(occ, selfEmail) {
  if (!occ.attendees.length) return false;
  if (selfEmail) {
    const me = occ.attendees.find((a) => a.email === String(selfEmail).toLowerCase());
    return me ? me.partstat === 'DECLINED' : false;
  }
  return occ.attendees.every((a) => a.partstat === 'DECLINED');
}

/**
 * The one event that best explains what is being recorded at `when`.
 *
 * Ranking, in order: a timed meeting in progress, then the nearest timed meeting
 * starting within the window either side, then an all-day item in progress.
 * All-day items rank last because "Team offsite" is a true answer and a useless
 * recording title, and it would otherwise beat the meeting about to start.
 *
 * Returns null rather than throwing on anything at all, because the caller is a
 * recording that has already started and must not be interrupted by a calendar.
 */
export function eventAt(events, when = new Date(), options = {}) {
  try {
    const nowMs = toMs(when);
    if (!Number.isFinite(nowMs)) return null;
    const { selfEmail = null, windowMs = 10 * MINUTE_MS } = options || {};
    const nearWindow = Math.max(0, Number(windowMs) || 0);

    // A day of lead-in so a long or multi-day meeting already under way is seen.
    const candidates = expandAll(events, new Date(nowMs - DAY_MS), new Date(nowMs + nearWindow + 1000))
      .filter((occ) => occ.status !== 'CANCELLED');

    let best = null;
    let bestKey = null;
    for (const occ of candidates) {
      const startMs = occ.start.getTime();
      const endMs = occ.end.getTime();
      const inProgress = startMs <= nowMs && endMs > nowMs;
      const delta = Math.abs(startMs - nowMs);

      let tier;
      if (inProgress && !occ.allDay) tier = 0;
      else if (!occ.allDay && delta <= nearWindow) tier = 1;
      else if (inProgress) tier = 2;
      else continue;

      // Declined loses to everything, but still beats returning nothing.
      const key = [isDeclined(occ, selfEmail) ? 1 : 0, tier, tier === 0 ? -startMs : delta];
      if (!bestKey || key[0] < bestKey[0]
        || (key[0] === bestKey[0] && key[1] < bestKey[1])
        || (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] < bestKey[2])) {
        best = occ;
        bestKey = key;
      }
    }

    return best ? toAgendaEvent(best, nowMs) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ fetch */

function isPrivateIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return true;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return true; // Malformed, refuse
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return true;          // this host, private, loopback
  if (a === 169 && b === 254) return true;                    // link local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 192 && b === 0) return true;                      // protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;          // carrier grade NAT
  if (a >= 224) return true;                                  // multicast and reserved
  return false;
}

/**
 * Cheap, literal checks only. This cannot stop a hostname that resolves to a
 * private address, which is why fetchCalendar also does a DNS pre-check.
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;

  if (h.includes(':')) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::') return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (/^f[cd]/.test(h)) return true;      // unique local
    if (/^fe[89ab]/.test(h)) return true;   // link local
    return false;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h);
  // Bare decimal and hex hosts are the classic loopback obfuscation (2130706433
  // is 127.0.0.1). No calendar feed needs them, so refuse the whole shape.
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true;
  return false;
}

class CalendarUrlError extends Error {}

/** Throws with a message safe to show a user: it names the host, never the secret path. */
function assertSafeUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new CalendarUrlError('That does not look like a URL. Paste the "Secret address in iCal format" from your calendar settings.');
  }
  if (url.protocol === 'webcal:') {
    throw new CalendarUrlError('This is a webcal: link. Change webcal:// to https:// at the front and paste it again.');
  }
  if (url.protocol !== 'https:') {
    throw new CalendarUrlError(`Only https calendar URLs are allowed, this one is ${url.protocol.replace(':', '')}.`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new CalendarUrlError(`Refusing to fetch from ${url.hostname}, that is a local or private address.`);
  }
  return url;
}

/**
 * Refuse a hostname that resolves into private space.
 *
 * This closes the redirect-to-intranet hole that the literal check cannot see.
 * It is not airtight (DNS can answer differently for the check and the request,
 * which is DNS rebinding) but it costs one lookup and stops the easy version.
 * Silently allowed if node:dns is unavailable, so the renderer can import this
 * module without blowing up.
 */
async function assertResolvesPublic(hostname) {
  let dns;
  try {
    dns = await import('node:dns/promises');
  } catch {
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new CalendarUrlError(`Could not resolve ${hostname}. Check the address and your connection.`);
  }
  for (const { address } of addresses) {
    if (isPrivateHost(address)) {
      throw new CalendarUrlError(`Refusing to fetch from ${hostname}, it points at a private address.`);
    }
  }
}

/** Read a body with a hard byte ceiling, aborting rather than buffering forever. */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CalendarUrlError(`That calendar is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  }
  if (!response.body) return await response.text();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CalendarUrlError(`That calendar is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buffer.set(c, offset); offset += c.byteLength; }

  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') || '')?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Fetch and parse an ICS feed. Never throws, always returns a result object.
 *
 * Redirects are followed by hand rather than by fetch, because every hop has to
 * be re-checked: a feed that 302s to http://192.168.1.1/ would otherwise turn a
 * pasted URL into a local network probe. `redirect: 'manual'` is what makes the
 * Location header visible for that check.
 */
export async function fetchCalendar(url, options = {}) {
  const fetchedAt = new Date();
  const requested = Number(options?.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(120000, Math.max(1000, requested))
    : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(Number(options?.maxBytes)) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : MAX_FEED_BYTES;

  const fail = (error) => ({ ok: false, events: [], error, fetchedAt });

  let target;
  try {
    target = assertSafeUrl(url);
  } catch (err) {
    return fail(err instanceof CalendarUrlError ? err.message : 'That calendar URL cannot be used.');
  }

  // One signal for the whole operation, redirects included, so a chain of slow
  // hops cannot add up past the timeout.
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    let hops = 0;
    for (;;) {
      await assertResolvesPublic(target.hostname);

      const response = await fetch(target.toString(), {
        signal,
        redirect: 'manual',
        headers: {
          accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          'user-agent': 'MIN calendar reader',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        try { await response.body?.cancel(); } catch { /* nothing to release */ }
        if (!location) return fail('That calendar redirected without saying where.');
        if (++hops > 5) return fail('That calendar redirected too many times.');
        let next;
        try {
          next = new URL(location, target);
        } catch {
          return fail('That calendar redirected to an address that is not valid.');
        }
        target = assertSafeUrl(next.toString());
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        return fail('That calendar URL was rejected. Regenerate the secret address in your calendar settings and paste the new one.');
      }
      if (response.status === 404) {
        return fail('No calendar at that address. Check you copied the whole secret URL.');
      }
      if (!response.ok) {
        return fail(`${target.hostname} returned ${response.status}.`);
      }

      const text = await readCapped(response, maxBytes);
      if (!/BEGIN:VCALENDAR/i.test(text)) {
        return fail(`${target.hostname} did not return a calendar. Make sure the URL ends in .ics.`);
      }

      return { ok: true, events: parseICS(text), error: null, fetchedAt };
    }
  } catch (err) {
    if (err instanceof CalendarUrlError) return fail(err.message);
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return fail(`${target.hostname} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    return fail(`Could not reach ${target.hostname}.`);
  }
}

/* --------------------------------------------------------------- filenames */

/**
 * A meeting title safe to use as a Windows folder name.
 *
 * This runs on attacker-influenced text: anyone who can put an event on the
 * user's calendar picks this string. So it strips path syntax rather than
 * escaping it, and refuses the reserved device names that make a folder
 * uncreatable on Windows even though they look harmless.
 */
export function sanitiseTitle(value, options = {}) {
  const maxLength = Math.max(8, Math.min(120, Number(options?.maxLength) || 80));
  const fallback = typeof options?.fallback === 'string' && options.fallback
    ? options.fallback
    : 'Untitled meeting';

  if (value == null) return fallback;
  let text = typeof value === 'string' ? value : String(value);

  try { text = text.normalize('NFC'); } catch { /* lone surrogates, use as-is */ }

  text = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Leading dots hide the folder on unix and make "." and ".." path traversal.
  text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
    text = text.replace(/[.\s]+$/, ''); // Truncation can expose a new trailing dot
  }

  if (!text) return fallback;

  // Windows blocks CON and CON.txt alike, so the check is on the stem.
  if (RESERVED_DEVICE_NAMES.has(text.split('.')[0].toUpperCase())) text = `${text}_`;

  return text || fallback;
}

/**
 * Exposed so the tests can exercise the pieces that only ever run mid-request,
 * the redirect guard and the size cap, without opening a socket to do it.
 */
export const _internals = {
  unfold, unescapeText, parseLine, parseDateValue, parseDuration, parseRRule,
  zoneOffsetMs, zonedWallToInstant, isPrivateHost, isPrivateIPv4, cleanText, stableId,
  assertSafeUrl, readCapped, CalendarUrlError, MAX_FEED_BYTES,
};
