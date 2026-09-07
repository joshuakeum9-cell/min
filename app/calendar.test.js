/**
 * MIN · calendar tests. Run: node app/calendar.test.js
 *
 * No framework, by the same reasoning as the module itself: a test runner is a
 * dependency, and this file has to keep working in a repo that ships unsigned and
 * never auto-updates. Node's own test runner was avoided too, so the output looks
 * like mcp/smoke-test.js and reads the same way.
 *
 * Nothing here touches the network. Every fixture is a template string, and every
 * fetchCalendar case is one that must be refused before a socket is opened.
 *
 * Timezone independence: instants are asserted as UTC ISO strings, which are the
 * same everywhere. Floating and all-day values are asserted through local getters,
 * because "floating" means "whatever this machine's clock says" by definition.
 */

import {
  parseICS,
  expandRecurring,
  upcoming,
  eventAt,
  fetchCalendar,
  sanitiseTitle,
  _internals,
} from './calendar.js';

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

/** Real feeds use CRLF, and the unfolding rule is written in terms of it. */
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));
const isoDay = (d) => iso(d).slice(0, 10);

/* ---------------------------------------------------------------- fixtures */

/**
 * Shaped like a real Google "Secret address in iCal format" export: the same
 * property order, the same 75-octet folding, a VTIMEZONE, a VALARM inside the
 * VEVENT, and a recurring university class, which is what the owner's calendar
 * actually contains.
 *
 * String.raw so that a backslash in the ICS stays a backslash for the parser to
 * unescape, rather than being consumed by JavaScript first.
 */
const GOOGLE_FEED = crlf(String.raw`BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:you@example.com
X-WR-TIMEZONE:America/New_York
BEGIN:VTIMEZONE
TZID:America/New_York
X-LIC-LOCATION:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260908T110500
DTEND;TZID=America/New_York:20260908T122000
RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20261211T045959Z;BYDAY=TU,TH
EXDATE;TZID=America/New_York:20261124T110500
DTSTAMP:20260904T120000Z
UID:class-mgmt301@google.com
CREATED:20260801T101500Z
DESCRIPTION:Seminar\, Building B\nBring the case pack\; slides
  are posted the night before.\nPath note: C:\\Users\\Example\\cases
LAST-MODIFIED:20260830T101500Z
LOCATION:Room 210\, 1 Campus Drive\, Springfield\, ST 00000
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:OPS-200 Operations Strategy, a title long enough that Google fol
 ds it across two lines
TRANSP:OPAQUE
ORGANIZER;CN=Registrar:mailto:registrar@example.edu
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Sam
  Rivera;X-NUM-GUESTS=0:mailto:you@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Sm
 ith: Jane";X-NUM-GUESTS=0:mailto:jane.smith@example.edu
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H10M0S
DTSTART:19990101T000000Z
SUMMARY:Reminder that must never become the meeting
END:VALARM
BEGIN:VALARM
ACTION:EMAIL
DESCRIPTION:Emailed reminder
TRIGGER:-P1D
ATTENDEE:mailto:alarm-robot@google.com
SUMMARY:Reminder
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260915T140000
DTEND;TZID=America/New_York:20260915T151500
DTSTAMP:20260904T120000Z
UID:class-mgmt301@google.com
RECURRENCE-ID;TZID=America/New_York:20260915T110500
SEQUENCE:1
STATUS:CONFIRMED
SUMMARY:OPS-200 guest lecture, room change
LOCATION:Lecture Hall A
END:VEVENT
BEGIN:VEVENT
DTSTART:20260907T133000Z
DTEND:20260907T134500Z
RRULE:FREQ=DAILY;COUNT=5
DTSTAMP:20260904T120000Z
UID:standup-0001@google.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Daily standup
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260910
DTEND;VALUE=DATE:20260911
DTSTAMP:20260904T120000Z
UID:module3-due@google.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Course project: Module 3 due
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
DTSTART:20260909T090000
DTEND:20260909T093000
DTSTAMP:20260904T120000Z
UID:floating-checkin@google.com
SEQUENCE:0
SUMMARY:Floating check-in
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260909T150000
DTEND;TZID=America/New_York:20260909T160000
DTSTAMP:20260904T120000Z
UID:dead-sync@google.com
SEQUENCE:2
STATUS:CANCELLED
SUMMARY:Cancelled recruiting sync
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260907
DTEND;VALUE=DATE:20260908
RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=1MO
DTSTAMP:20260904T120000Z
UID:labor-day@google.com
SUMMARY:Labor Day
END:VEVENT
END:VCALENDAR
`);

const MONTHLY_FEED = crlf(String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
DTSTART:20260910T180000Z
DTEND:20260910T190000Z
RRULE:FREQ=MONTHLY;BYDAY=2TH
UID:monthly-nth@example.com
SUMMARY:Second Thursday review
END:VEVENT
BEGIN:VEVENT
DTSTART:20260901T120000Z
DTEND:20260901T123000Z
RRULE:FREQ=MONTHLY;BYMONTHDAY=1,-1
UID:monthly-bookends@example.com
SUMMARY:Month bookends
END:VEVENT
BEGIN:VEVENT
DTSTART:20260901T080000Z
DTEND:20260901T081500Z
RRULE:FREQ=DAILY
UID:runaway@example.com
SUMMARY:Never ending
END:VEVENT
END:VCALENDAR
`);

const NOW_FEED = crlf(String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
DTSTART:20260904T150000Z
DTEND:20260904T160000Z
UID:case-prep@example.com
SUMMARY:Case interview practice
LOCATION:Zoom
ATTENDEE;PARTSTAT=ACCEPTED;CN=Sam Rivera:mailto:you@example.com
ATTENDEE;PARTSTAT=ACCEPTED;CN=Coach:mailto:coach@example.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20260904T150000Z
DTEND:20260904T160000Z
UID:dead-allhands@example.com
SUMMARY:All hands nobody is going to
ATTENDEE;PARTSTAT=DECLINED;CN=Sam Rivera:mailto:you@example.com
ATTENDEE;PARTSTAT=DECLINED;CN=Someone:mailto:someone@example.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20260904T150000Z
DTEND:20260904T160000Z
UID:cancelled-now@example.com
STATUS:CANCELLED
SUMMARY:Cancelled thing happening now
END:VEVENT
BEGIN:VEVENT
DTSTART:20260904T171000Z
DTEND:20260904T174000Z
UID:starting-soon@example.com
SUMMARY:EY advisory coffee chat
END:VEVENT
END:VCALENDAR
`);

const ALLDAY_ONLY_FEED = crlf(String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260903
DTEND;VALUE=DATE:20260907
UID:offsite@example.com
SUMMARY:Team offsite
END:VEVENT
END:VCALENDAR
`);

const CANCELLED_ONLY_FEED = crlf(String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
DTSTART:20260904T150000Z
DTEND:20260904T160000Z
UID:only-cancelled@example.com
STATUS:CANCELLED
SUMMARY:Recruiting sync that was called off
END:VEVENT
END:VCALENDAR
`);

/**
 * Apple and Outlook often write EXDATE as a floating value even when DTSTART
 * carries a TZID, so the exclusion has to match on wall clock as well as instant.
 */
const FLOATING_EXDATE_FEED = crlf(String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260907T090000
DTEND;TZID=America/New_York:20260907T093000
RRULE:FREQ=DAILY;COUNT=4
EXDATE:20260909T090000
UID:floating-exdate@example.com
SUMMARY:Standup with a floating exclusion
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260907T090000
DTEND;TZID=America/New_York:20260907T093000
RRULE:FREQ=DAILY;COUNT=4
EXDATE:20260909T130000Z
UID:utc-exdate@example.com
SUMMARY:Standup with a UTC exclusion
END:VEVENT
END:VCALENDAR
`);

const SELF_DECLINE_FEED = crlf(String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
DTSTART:20260904T150000Z
DTEND:20260904T160000Z
UID:declined-by-me@example.com
SUMMARY:Meeting I declined
ATTENDEE;PARTSTAT=DECLINED:mailto:you@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:host@example.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20260904T150000Z
DTEND:20260904T160000Z
UID:accepted-by-me@example.com
SUMMARY:Meeting I accepted
ATTENDEE;PARTSTAT=ACCEPTED:mailto:you@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:host@example.com
END:VEVENT
END:VCALENDAR
`);

const events = parseICS(GOOGLE_FEED);
const byUid = (uid) => events.filter((e) => e.uid === uid);
const klass = byUid('class-mgmt301@google.com').find((e) => !e.recurrenceId);
const standup = byUid('standup-0001@google.com')[0];
const allDay = byUid('module3-due@google.com')[0];
const floating = byUid('floating-checkin@google.com')[0];
const cancelled = byUid('dead-sync@google.com')[0];
const laborDay = byUid('labor-day@google.com')[0];

/* ------------------------------------------------------------------- tests */

section('parseICS , structure');
eq('seven VEVENTs parsed, VTIMEZONE and VALARM skipped', events.length, 7);
ok('the VALARM did not become an event', !events.some((e) => e.summary.startsWith('Reminder')));
ok('the VTIMEZONE DTSTARTs did not become events', !events.some((e) => e.start.getUTCFullYear() === 1970));
eq('SEQUENCE parsed as a number', klass.sequence, 0);
eq('STATUS parsed', klass.status, 'CONFIRMED');
eq('ORGANIZER CN parsed', klass.organizer.name, 'Registrar');
eq('ORGANIZER mailto stripped', klass.organizer.email, 'registrar@example.edu');
eq('repeated ATTENDEE collected', klass.attendees.length, 2);
eq('ATTENDEE PARTSTAT parsed', klass.attendees[0].partstat, 'ACCEPTED');
eq('parseICS returns [] for junk', parseICS('not a calendar at all'), []);
eq('parseICS returns [] for empty input', parseICS(''), []);
eq('parseICS returns [] for a non-string', parseICS(null), []);

section('parseICS , line unfolding');
eq(
  'a folded SUMMARY rejoins mid-word',
  klass.summary,
  'OPS-200 Operations Strategy, a title long enough that Google folds it across two lines',
);
eq('a folded parameter rejoins', klass.attendees[0].name, 'Sam Rivera');
eq('a quoted parameter containing a colon survives', klass.attendees[1].name, 'Smith: Jane');
eq('unfold drops exactly one leading space', _internals.unfold('A:one\r\n two'), 'A:onetwo');
eq('unfold handles a bare LF fold', _internals.unfold('A:one\n\ttwo'), 'A:onetwo');
ok('unfold leaves a real new line alone', _internals.unfold('A:one\r\nB:two').includes('B:two'));

section('parseICS , escaped text');
ok('escaped \\n became a real new line', klass.description.includes('case pack; slides are posted'));
eq('description line count', klass.description.split('\n').length, 3);
ok('escaped semicolon unescaped', klass.description.includes('case pack; slides'));
ok('escaped backslash unescaped', klass.description.includes('C:\\Users\\Example\\cases'));
eq('escaped commas in LOCATION', klass.location, 'Room 210, 1 Campus Drive, New York, NY 10012');
eq('unescapeText handles a trailing lone backslash', _internals.unescapeText('end\\'), 'end\\');
eq('unescapeText handles all four escapes', _internals.unescapeText('a\\nb\\,c\\;d\\\\e'), 'a\nb,c;d\\e');

section('parseICS , the three DTSTART forms plus TZID');
eq('UTC start is an exact instant', iso(standup.start), '2026-09-07T13:30:00.000Z');
eq('UTC start records the UTC zone', standup.tzid, 'UTC');
eq('UTC end is an exact instant', iso(standup.end), '2026-09-07T13:45:00.000Z');

eq('DATE-only start is flagged all-day', allDay.allDay, true);
eq('DATE-only start is local midnight', [allDay.start.getHours(), allDay.start.getMinutes()], [0, 0]);
eq('DATE-only start is the right local day', allDay.start.getDate(), 10);
eq('DATE-only end is the next local midnight', allDay.end.getDate(), 11);
eq('DATE-only start floats, so no zone', allDay.tzid, null);

eq('floating start is not all-day', floating.allDay, false);
eq('floating start uses the local clock', [floating.start.getHours(), floating.start.getMinutes()], [9, 0]);
eq('floating start has no zone', floating.tzid, null);

eq('TZID start converts to a real instant', iso(klass.start), '2026-09-08T15:05:00.000Z');
eq('TZID end converts to a real instant', iso(klass.end), '2026-09-08T16:20:00.000Z');
eq('TZID is kept on the event', klass.tzid, 'America/New_York');

section('time zones , offsets and DST');
eq('New York is UTC-4 in summer', _internals.zoneOffsetMs('America/New_York', Date.parse('2026-07-01T12:00:00Z')), -4 * 3600000);
eq('New York is UTC-5 in winter', _internals.zoneOffsetMs('America/New_York', Date.parse('2026-01-15T12:00:00Z')), -5 * 3600000);
eq('London is UTC+0 in winter', _internals.zoneOffsetMs('Europe/London', Date.parse('2026-01-15T12:00:00Z')), 0);
eq('Kolkata has a half-hour offset', _internals.zoneOffsetMs('Asia/Kolkata', Date.parse('2026-01-15T12:00:00Z')), 5.5 * 3600000);
eq(
  'a summer wall time resolves through EDT',
  iso(new Date(_internals.zonedWallToInstant(Date.UTC(2026, 8, 8, 11, 5), 'America/New_York'))),
  '2026-09-08T15:05:00.000Z',
);
eq(
  'a winter wall time resolves through EST',
  iso(new Date(_internals.zonedWallToInstant(Date.UTC(2026, 11, 10, 11, 5), 'America/New_York'))),
  '2026-12-10T16:05:00.000Z',
);
eq(
  'the ambiguous fall-back hour takes the first pass',
  iso(new Date(_internals.zonedWallToInstant(Date.UTC(2026, 10, 1, 1, 30), 'America/New_York'))),
  '2026-11-01T05:30:00.000Z',
);
eq(
  'a wall time inside the spring-forward gap lands after it',
  iso(new Date(_internals.zonedWallToInstant(Date.UTC(2026, 2, 8, 2, 30), 'America/New_York'))),
  '2026-03-08T07:30:00.000Z',
);
{
  const outlook = parseICS(crlf(String.raw`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=Eastern Standard Time:20260908T110500
DTEND;TZID=Eastern Standard Time:20260908T120500
UID:outlook-zone@example.com
SUMMARY:Windows zone name
END:VEVENT
END:VCALENDAR`))[0];
  eq('an unknown TZID is flagged', outlook.tzUnknown, true);
  eq('an unknown TZID falls back to floating, not dropped', outlook.start.getHours(), 11);
}

section('expandRecurring , weekly BYDAY across a range');
{
  const occ = expandRecurring(klass, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 9, 1)));
  eq('September has seven class meetings', occ.length, 7);
  eq(
    'they land on the right Tuesdays and Thursdays',
    occ.map((e) => isoDay(e.start)),
    ['2026-09-08', '2026-09-10', '2026-09-15', '2026-09-17', '2026-09-22', '2026-09-24', '2026-09-29'],
  );
  eq('the wall time is held across every occurrence', iso(occ[5].start), '2026-09-24T15:05:00.000Z');
  eq('duration is carried onto occurrences', occ[1].end - occ[1].start, 75 * 60000);
  eq('occurrences keep the master summary', occ[0].summary, klass.summary);
  eq('occurrences are flagged as recurrences', occ[0].isRecurrence, true);
}
{
  const occ = expandRecurring(klass, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 11, 31)));
  eq(
    'the class survives the DST change at the same wall time',
    iso(occ[0].start),
    '2026-11-03T16:05:00.000Z',
  );
  eq('November and December, minus the exclusion', occ.length, 11);
}

section('expandRecurring , COUNT, UNTIL and EXDATE');
{
  const occ = expandRecurring(standup, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2027, 0, 1)));
  eq('COUNT=5 yields exactly five standups', occ.length, 5);
  eq(
    'and they are five consecutive days from DTSTART',
    occ.map((e) => isoDay(e.start)),
    ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
  );
}
{
  const occ = expandRecurring(klass, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2027, 5, 1)));
  eq('UNTIL stops the series on 10 December', isoDay(occ[occ.length - 1].start), '2026-12-10');
  ok('nothing is generated past UNTIL', occ.every((e) => e.start.getTime() <= Date.parse('2026-12-11T04:59:59Z')));
}
{
  const occ = expandRecurring(klass, new Date(Date.UTC(2026, 10, 20)), new Date(Date.UTC(2026, 10, 30)));
  const days = occ.map((e) => isoDay(e.start));
  ok('the EXDATE on 24 November is excluded', !days.includes('2026-11-24'), show(days));
  ok('the untouched 26 November is still there', days.includes('2026-11-26'), show(days));
}
{
  const feed = parseICS(FLOATING_EXDATE_FEED);
  const daysOf = (uid) => expandRecurring(
    feed.find((e) => e.uid === uid),
    new Date(Date.UTC(2026, 8, 1)),
    new Date(Date.UTC(2026, 8, 30)),
  ).map((e) => isoDay(e.start));
  eq('a floating EXDATE against a zoned DTSTART still excludes', daysOf('floating-exdate@example.com'), ['2026-09-07', '2026-09-08', '2026-09-10']);
  eq('and so does a UTC EXDATE against a zoned DTSTART', daysOf('utc-exdate@example.com'), ['2026-09-07', '2026-09-08', '2026-09-10']);
}
{
  // The zone is picked at run time to be one the machine is definitely not in,
  // otherwise reading a bare EXDATE locally would give the same answer by luck
  // and the check would prove nothing.
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = local === 'Asia/Kolkata' ? 'America/New_York' : 'Asia/Kolkata';
  const expected = zone === 'Asia/Kolkata' ? '2026-09-09T03:30:00.000Z' : '2026-09-09T13:00:00.000Z';
  const ev = parseICS(crlf(`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=${zone}:20260907T090000
DTEND;TZID=${zone}:20260907T093000
RRULE:FREQ=DAILY;COUNT=4
EXDATE:20260909T090000
UID:zone-normalised-exdate@example.com
SUMMARY:Bare EXDATE against a zoned DTSTART
END:VEVENT
END:VCALENDAR`))[0];
  eq('a bare EXDATE is read in the event zone, not the machine zone', iso(new Date(ev.exdates[0].instantMs)), expected);
  eq(
    'so the right day drops out wherever the machine is',
    expandRecurring(ev, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 8, 30))).map((e) => isoDay(e.start)),
    ['2026-09-07', '2026-09-08', '2026-09-10'],
  );
}

section('expandRecurring , RECURRENCE-ID override');
{
  const occ = expandRecurring(klass, new Date(Date.UTC(2026, 8, 14)), new Date(Date.UTC(2026, 8, 16)));
  eq('the overridden week produces one occurrence, not two', occ.length, 1);
  eq('the override replaces the summary', occ[0].summary, 'OPS-200 guest lecture, room change');
  eq('the override moves the start time', iso(occ[0].start), '2026-09-15T18:00:00.000Z');
  eq('the override replaces the location', occ[0].location, 'Lecture Hall A');
  eq('the override is flagged', occ[0].isOverride, true);
}
{
  const agenda = upcoming(events, { from: new Date(Date.UTC(2026, 8, 15, 6)), days: 1 });
  const titles = agenda.flatMap((g) => g.events.map((e) => e.title));
  eq('the override does not also appear as a separate event', titles.filter((t) => t.includes('OPS-200')).length, 1);
}

section('expandRecurring , range edges east and west of UTC');
{
  // The expander works in wall clock and the range is given in instants, so a
  // zone far from UTC puts those two out of step by most of a day. Tokyo at 09:00
  // is midnight UTC: a range ending at 01:00 UTC still contains it.
  const tokyo = parseICS(crlf(String.raw`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20260907T090000
DTEND;TZID=Asia/Tokyo:20260907T093000
RRULE:FREQ=DAILY;COUNT=3
UID:tokyo-standup@example.com
SUMMARY:Tokyo standup
END:VEVENT
END:VCALENDAR`))[0];
  eq('a Tokyo morning is a UTC midnight', iso(tokyo.start), '2026-09-07T00:00:00.000Z');
  eq(
    'and a range ending an hour into that day still contains it',
    expandRecurring(tokyo, new Date(Date.UTC(2026, 8, 7, 0)), new Date(Date.UTC(2026, 8, 7, 1))).map((e) => iso(e.start)),
    ['2026-09-07T00:00:00.000Z'],
  );

  // The mirror case: Honolulu evening is the next day in UTC.
  const hawaii = parseICS(crlf(String.raw`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=Pacific/Honolulu:20260907T200000
DTEND;TZID=Pacific/Honolulu:20260907T203000
RRULE:FREQ=DAILY;COUNT=3
UID:hawaii-standup@example.com
SUMMARY:Honolulu evening
END:VEVENT
END:VCALENDAR`))[0];
  eq('a Honolulu evening is the next UTC day', iso(hawaii.start), '2026-09-08T06:00:00.000Z');
  eq(
    'and a range starting that morning still contains it',
    expandRecurring(hawaii, new Date(Date.UTC(2026, 8, 8, 5)), new Date(Date.UTC(2026, 8, 8, 7))).map((e) => iso(e.start)),
    ['2026-09-08T06:00:00.000Z'],
  );
}

section('expandRecurring , monthly forms and the safety cap');
{
  const monthly = parseICS(MONTHLY_FEED);
  const nth = monthly.find((e) => e.uid === 'monthly-nth@example.com');
  const bookends = monthly.find((e) => e.uid === 'monthly-bookends@example.com');
  const runaway = monthly.find((e) => e.uid === 'runaway@example.com');

  eq(
    'BYDAY=2TH picks the second Thursday of each month',
    expandRecurring(nth, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2027, 0, 1))).map((e) => isoDay(e.start)),
    ['2026-09-10', '2026-10-08', '2026-11-12', '2026-12-10'],
  );
  eq(
    'BYMONTHDAY=1,-1 picks the first and last day of each month',
    expandRecurring(bookends, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 10, 1))).map((e) => isoDay(e.start)),
    ['2026-09-01', '2026-09-30', '2026-10-01', '2026-10-31'],
  );
  eq(
    'an unbounded daily rule is capped rather than allowed to run',
    expandRecurring(runaway, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2036, 8, 1))).length,
    500,
  );
}

section('expandRecurring , rules that cannot be expanded');
eq('an RRULE with BYMONTH is flagged', laborDay.rruleUnsupported, true);
eq('and says why', laborDay.rruleUnsupportedReason, 'BYMONTH');
eq(
  'a flagged rule emits the base event once',
  expandRecurring(laborDay, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2028, 0, 1))).length,
  1,
);
eq('a non-recurring event yields itself once', expandRecurring(allDay, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 9, 1))).length, 1);
eq('an event outside the range yields nothing', expandRecurring(allDay, new Date(Date.UTC(2027, 0, 1)), new Date(Date.UTC(2027, 1, 1))).length, 0);
eq('expandRecurring tolerates a null event', expandRecurring(null, new Date(), new Date()), []);
eq('expandRecurring tolerates a bad range', expandRecurring(allDay, 'nonsense', new Date()), []);

section('upcoming , the home screen agenda');
{
  const from = new Date(Date.UTC(2026, 8, 8, 15, 30)); // mid-class
  const agenda = upcoming(events, { from, days: 4 });
  const flat = agenda.flatMap((g) => g.events);

  ok('the agenda is grouped into days', agenda.length >= 2, `${agenda.length} groups`);
  ok('days are in ascending order', agenda.every((g, i) => i === 0 || agenda[i - 1].date < g.date));
  ok('every group has a label', agenda.every((g) => typeof g.label === 'string' && g.label.length > 0));
  eq('the first group is labelled Today', agenda[0].label, 'Today');
  ok('events within a day are sorted by start', agenda.every((g) => g.events.every((e, i) => i === 0 || g.events[i - 1].start <= e.start)));

  const inClass = flat.find((e) => e.title.startsWith('OPS-200'));
  ok('a meeting already under way is included', Boolean(inClass));
  eq('and is marked in progress', inClass.inProgress, true);
  eq('it carries an attendee count', inClass.attendeeCount, 2);
  eq('it carries a location', inClass.location, 'Room 210, 1 Campus Drive, New York, NY 10012');
  eq('it is marked recurring', inClass.recurring, true);
  ok('it has a stable id', /^ev_[0-9a-f]{8}$/.test(inClass.id), inClass.id);

  const again = upcoming(events, { from, days: 4 }).flatMap((g) => g.events).find((e) => e.title.startsWith('OPS-200'));
  eq('the id is stable across calls', again.id, inClass.id);

  const module3 = flat.find((e) => e.title.startsWith('Course project'));
  ok('an all-day event appears', Boolean(module3));
  eq('and carries the all-day flag', module3.allDay, true);

  ok('a cancelled event is left out', !flat.some((e) => e.title.includes('Cancelled')));
  ok('no event starts before the window', flat.every((e) => e.end.getTime() > from.getTime()));

  const tomorrow = agenda.find((g) => g.label === 'Tomorrow');
  ok('the second day is labelled Tomorrow', Boolean(tomorrow));
}
eq('upcoming of nothing is an empty agenda', upcoming([], { from: new Date(), days: 7 }), []);
eq('upcoming tolerates a missing options object', Array.isArray(upcoming([])), true);
eq('upcoming tolerates a null calendar', upcoming(null, { days: 7 }), []);
eq('upcoming drops junk entries instead of throwing', upcoming(['junk', 42, null, {}], { days: 7 }), []);
eq(
  'and keeps the real events alongside the junk',
  upcoming([null, 'junk'].concat(events), { from: new Date(Date.UTC(2026, 8, 8, 15, 30)), days: 1 })
    .flatMap((g) => g.events).length > 0,
  true,
);

section('eventAt , picking what to title a recording');
{
  const now = parseICS(NOW_FEED);
  const during = eventAt(now, new Date(Date.UTC(2026, 8, 4, 15, 30)));
  ok('an in-progress meeting is found', Boolean(during));
  eq('and it is the accepted one', during.title, 'Case interview practice');
  eq('it comes back agenda-shaped', typeof during.id === 'string' && during.start instanceof Date, true);
  eq('a cancelled meeting is never chosen', during.status, null);

  const soon = eventAt(now, new Date(Date.UTC(2026, 8, 4, 17, 5)));
  eq('a meeting starting in five minutes is picked up', soon && soon.title, 'EY advisory coffee chat');

  const justAfter = eventAt(now, new Date(Date.UTC(2026, 8, 4, 17, 45)));
  eq('a meeting that ended five minutes ago is not', justAfter, null);

  eq('nothing within ten minutes returns null', eventAt(now, new Date(Date.UTC(2026, 8, 4, 12, 0))), null);
  eq(
    'a cancelled meeting in progress, alone, returns null',
    eventAt(parseICS(CANCELLED_ONLY_FEED), new Date(Date.UTC(2026, 8, 4, 15, 30))),
    null,
  );
  eq(
    'and a cancelled meeting never wins the tie-break either',
    eventAt(parseICS(CANCELLED_ONLY_FEED).concat(now), new Date(Date.UTC(2026, 8, 4, 15, 30))).title,
    'Case interview practice',
  );
  eq('an empty calendar returns null', eventAt([], new Date()), null);
  eq('a null calendar returns null', eventAt(null, new Date()), null);
  eq('a nonsense moment returns null', eventAt(now, 'not a date'), null);
  eq('a nonsense calendar returns null', eventAt(['garbage', 42], new Date()), null);
  eq('no arguments at all returns null', eventAt(), null);
}
{
  const offsite = parseICS(ALLDAY_ONLY_FEED);
  const probe = new Date(offsite[0].start.getTime() + 6 * 3600000);
  eq('an all-day event is used when nothing else is on', eventAt(offsite, probe).title, 'Team offsite');

  const mixed = parseICS(ALLDAY_ONLY_FEED).concat(parseICS(NOW_FEED));
  eq(
    'but a timed meeting in progress beats it',
    eventAt(mixed, new Date(Date.UTC(2026, 8, 4, 15, 30))).title,
    'Case interview practice',
  );
  eq(
    'and so does a timed meeting five minutes away',
    eventAt(mixed, new Date(Date.UTC(2026, 8, 4, 17, 5))).title,
    'EY advisory coffee chat',
  );
}
{
  const feed = parseICS(SELF_DECLINE_FEED);
  eq(
    'with selfEmail, a meeting the user declined loses',
    eventAt(feed, new Date(Date.UTC(2026, 8, 4, 15, 30)), { selfEmail: 'you@example.com' }).title,
    'Meeting I accepted',
  );
}

section('sanitiseTitle , safe for a Windows folder name');
eq('path separators are removed', sanitiseTitle('Notes/2026\\Q3'), 'Notes 2026 Q3');
eq('a colon is removed', sanitiseTitle('Weekly 1:1 with Dana'), 'Weekly 1 1 with Dana');
eq('the other forbidden characters go too', sanitiseTitle('a*b?c"d<e>f|g'), 'a b c d e f g');
eq('path traversal cannot survive', sanitiseTitle('../../Windows/System32'), 'Windows System32');
eq('a lone dot run falls back', sanitiseTitle('...'), 'Untitled meeting');
eq('trailing dots are stripped', sanitiseTitle('Quarterly review.'), 'Quarterly review');
eq('trailing spaces are stripped', sanitiseTitle('Quarterly review   '), 'Quarterly review');
eq('whitespace is collapsed', sanitiseTitle('  too    many   spaces  '), 'too many spaces');
eq('control characters become spaces', sanitiseTitle(`Bad${String.fromCharCode(0)}Ti${String.fromCharCode(9)}tle`), 'Bad Ti tle');
eq('a bidi override is deleted outright', sanitiseTitle(`Invoice${String.fromCharCode(0x202e)}gnp.exe`), 'Invoicegnp.exe');
eq('a zero-width space is deleted outright', sanitiseTitle(`Stand${String.fromCharCode(0x200b)}up`), 'Standup');
eq('CON is refused', sanitiseTitle('CON'), 'CON_');
eq('con.txt is refused too', sanitiseTitle('con.txt'), 'con.txt_');
eq('lowercase nul is refused', sanitiseTitle('nul'), 'nul_');
eq('COM1 is refused', sanitiseTitle('COM1'), 'COM1_');
eq('LPT9 is refused', sanitiseTitle('LPT9'), 'LPT9_');
eq('PRN is refused', sanitiseTitle('PRN'), 'PRN_');
eq('AUX is refused', sanitiseTitle('AUX'), 'AUX_');
eq('COM0 is not reserved', sanitiseTitle('COM0'), 'COM0');
eq('CONSTRUCTION is not reserved', sanitiseTitle('CONSTRUCTION'), 'CONSTRUCTION');
ok('a long title is capped', sanitiseTitle('A'.repeat(400)).length === 80, String(sanitiseTitle('A'.repeat(400)).length));
ok('a long title is cut at a word boundary', !sanitiseTitle(`${'word '.repeat(40)}end`).endsWith('wor'));
ok('truncation never leaves a trailing dot', !sanitiseTitle(`${'x'.repeat(79)}. tail`).endsWith('.'));
eq('an empty string falls back', sanitiseTitle(''), 'Untitled meeting');
eq('null falls back', sanitiseTitle(null), 'Untitled meeting');
eq('undefined falls back', sanitiseTitle(undefined), 'Untitled meeting');
eq('whitespace only falls back', sanitiseTitle('   '), 'Untitled meeting');
eq('a custom fallback is honoured', sanitiseTitle('', { fallback: 'Meeting' }), 'Meeting');
eq('a number is stringified, not rejected', sanitiseTitle(2026), '2026');
eq('unicode is kept', sanitiseTitle('Reunion cafe 2026'), 'Reunion cafe 2026');
eq('a real parsed summary is usable', sanitiseTitle(parseICS(NOW_FEED)[0].summary), 'Case interview practice');

section('fetchCalendar , refusing before a socket is opened');
{
  const refuse = async (label, url, mustMention) => {
    const r = await fetchCalendar(url, { timeoutMs: 1000 });
    const good = r && r.ok === false && typeof r.error === 'string' && r.error.length > 0
      && Array.isArray(r.events) && r.events.length === 0 && r.fetchedAt instanceof Date
      && (!mustMention || r.error.toLowerCase().includes(mustMention));
    ok(label, good, r ? show(r.error) : 'no result');
  };

  await refuse('http is refused', 'http://example.com/basic.ics', 'https');
  await refuse('file: is refused', 'file:///C:/Users/Alex/secret.ics', 'https');
  await refuse('ftp: is refused', 'ftp://example.com/basic.ics', 'https');
  await refuse('data: is refused', 'data:text/calendar,BEGIN:VCALENDAR', 'https');
  await refuse('webcal: is refused with advice', 'webcal://example.com/basic.ics', 'webcal');
  await refuse('a non-URL is refused', 'just some text', 'url');
  await refuse('localhost is refused', 'https://localhost/basic.ics', 'private');
  await refuse('localhost with a port is refused', 'https://localhost:8443/basic.ics', 'private');
  await refuse('127.0.0.1 is refused', 'https://127.0.0.1/basic.ics', 'private');
  await refuse('anything in 127.0.0.0/8 is refused', 'https://127.9.9.9/basic.ics', 'private');
  await refuse('::1 is refused', 'https://[::1]/basic.ics', 'private');
  await refuse('10.x is refused', 'https://10.1.2.3/basic.ics', 'private');
  await refuse('192.168.x is refused', 'https://192.168.1.1/basic.ics', 'private');
  await refuse('172.16.x is refused', 'https://172.16.0.1/basic.ics', 'private');
  await refuse('172.31.x is refused', 'https://172.31.255.254/basic.ics', 'private');
  await refuse('169.254.x is refused', 'https://169.254.169.254/latest/meta-data', 'private');
  await refuse('a .local name is refused', 'https://nas.local/basic.ics', 'private');
  await refuse('a decimal-encoded loopback is refused', 'https://2130706433/basic.ics', 'private');

  const leaky = await fetchCalendar('https://localhost/private-1a2b3c4d5e/basic.ics', { timeoutMs: 1000 });
  ok('the error never echoes the secret path', !leaky.error.includes('1a2b3c4d5e'), leaky.error);

  ok('fetchCalendar never throws on garbage input', await (async () => {
    for (const bad of [null, undefined, 42, {}, [], '']) {
      const r = await fetchCalendar(bad, { timeoutMs: 1000 });
      if (!r || r.ok !== false || typeof r.error !== 'string') return false;
    }
    return true;
  })());
}

section('fetchCalendar , the redirect guard');
{
  // Every hop is re-checked, so these are the decisions fetchCalendar makes on a
  // Location header. Exercised directly because a real redirect needs a network.
  const base = 'https://calendar.example.com/ical/secret-1a2b3c/basic.ics';
  const hop = (location) => _internals.assertSafeUrl(new URL(location, base).toString()).toString();
  const refuses = (location) => {
    try { hop(location); return false; } catch (err) { return err instanceof _internals.CalendarUrlError; }
  };

  eq('a relative redirect stays on the same host', hop('/ical/other.ics'), 'https://calendar.example.com/ical/other.ics');
  eq('an https redirect to another public host is allowed', hop('https://cdn.example.net/basic.ics'), 'https://cdn.example.net/basic.ics');
  ok('a redirect down to http is refused', refuses('http://calendar.example.com/basic.ics'));
  ok('a redirect to loopback is refused', refuses('https://127.0.0.1/basic.ics'));
  ok('a redirect to the metadata service is refused', refuses('https://169.254.169.254/latest/meta-data'));
  ok('a redirect to an intranet name is refused', refuses('https://wiki.internal/basic.ics'));
  ok('a redirect to file: is refused', refuses('file:///C:/Windows/win.ini'));
}

section('fetchCalendar , the response size cap');
{
  const body = (chunks, headers = {}) => new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }),
    { headers },
  );

  const small = await _internals.readCapped(body(['BEGIN:VCALENDAR', 'END:VCALENDAR']), 1024);
  eq('a small body is decoded whole', small, 'BEGIN:VCALENDAREND:VCALENDAR');

  let capped = false;
  try {
    await _internals.readCapped(body(['x'.repeat(600), 'y'.repeat(600)]), 1000);
  } catch (err) {
    capped = err instanceof _internals.CalendarUrlError;
  }
  ok('a body that streams past the cap is aborted', capped);

  let declared = false;
  try {
    await _internals.readCapped(body(['x'], { 'content-length': '99999999' }), 1000);
  } catch (err) {
    declared = err instanceof _internals.CalendarUrlError;
  }
  ok('a declared content-length past the cap is refused up front', declared);
  eq('the shipped cap is a few megabytes', _internals.MAX_FEED_BYTES, 4 * 1024 * 1024);
}

section('fetchCalendar , the host checks themselves');
eq('172.15.x is public', _internals.isPrivateHost('172.15.0.1'), false);
eq('172.32.x is public', _internals.isPrivateHost('172.32.0.1'), false);
eq('a normal hostname is public', _internals.isPrivateHost('calendar.google.com'), false);
eq('a public IP is public', _internals.isPrivateHost('142.250.72.14'), false);
eq('0.0.0.0 is refused', _internals.isPrivateHost('0.0.0.0'), true);
eq('a link-local IPv6 address is refused', _internals.isPrivateHost('fe80::1'), true);
eq('a unique-local IPv6 address is refused', _internals.isPrivateHost('fd00::1'), true);
eq('an IPv4-mapped loopback is refused', _internals.isPrivateHost('::ffff:127.0.0.1'), true);
eq('a malformed dotted quad is refused', _internals.isPrivateHost('999.1.1.1'), true);
eq('an empty host is refused', _internals.isPrivateHost(''), true);

/* ------------------------------------------------------------------ result */

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
