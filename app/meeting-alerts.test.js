/**
 * MIN · meeting alert tests. Run: node app/meeting-alerts.test.js
 *
 * No framework, by the same reasoning as calendar.test.js: a test runner is a
 * dependency, and this repo ships unsigned and never auto-updates. The output is
 * shaped like the other suites so a failure reads the same way wherever it comes
 * from.
 *
 * Nothing here reads the machine clock. Every instant is a fixed epoch plus an
 * offset in milliseconds, so the boundary checks below mean the same thing in
 * New York, in a CI container set to UTC and on a laptop whose clock is wrong.
 */

import { alertKey, isAlertable, pendingAlert, nextWakeMs } from './meeting-alerts.js';

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

/* ---------------------------------------------------------------- fixtures */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A Tuesday in the middle of the owner's term, so the numbers below are real times. */
const NOW = Date.parse('2026-09-08T15:00:00.000Z');

const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

/**
 * Shaped exactly like serialiseEvent in calendar-store.js, because that object is
 * what the main process has in hand when it asks these questions. Anything the
 * decision does not read is still here, so a field quietly starting to matter
 * would show up as a test that passes for the wrong reason.
 */
function ev(id, offsetMs, extra = {}) {
  return {
    id,
    uid: `${id}@example.com`,
    title: 'Case interview practice',
    start: iso(offsetMs),
    end: iso(offsetMs + 60 * MINUTE),
    allDay: false,
    location: 'Zoom',
    attendees: ['Sam Rivera', 'Coach'],
    attendeeCount: 2,
    recurring: false,
    inProgress: false,
    ...extra,
  };
}

/** The two things a caller reads off a pending alert. */
const idOf = (r) => (r ? r.event.id : null);
const inMs = (r) => (r ? r.startsInMs : null);

const GARBAGE = [null, undefined, 'an event', 42, true, [], {}, () => {}];

/* ------------------------------------------------------------------- tests */

section('alertKey , one occurrence, one key');
eq('the id is used when there is one', alertKey(ev('ev_1a2b3c4d', 5 * MINUTE)), 'ev_1a2b3c4d');
eq(
  'without an id it falls back to uid plus start instant',
  alertKey({ uid: 'class-mgmt301@google.com', start: iso(0), id: null }),
  `class-mgmt301@google.com|${NOW}`,
);
eq('an id wins even when the start is unreadable', alertKey({ id: 'ev_9', start: 'sometime' }), 'ev_9');
eq('a blank id falls through to the uid', alertKey({ id: '   ', uid: 'u@x', start: iso(0) }), `u@x|${NOW}`);
{
  const first = { uid: 'class-mgmt301@google.com', start: iso(0) };
  const second = { uid: 'class-mgmt301@google.com', start: iso(2 * 24 * 60 * MINUTE) };
  ok('two occurrences of one recurring uid get different keys', alertKey(first) !== alertKey(second), alertKey(first));
  eq('and the same occurrence gets the same key twice', alertKey(first), alertKey({ ...first }));
}
{
  const tue = ev('ev_aaaa1111', 0, { recurring: true, uid: 'class-mgmt301@google.com' });
  const thu = ev('ev_bbbb2222', 2 * 24 * 60 * MINUTE, { recurring: true, uid: 'class-mgmt301@google.com' });
  ok('hashed ids for two occurrences differ too', alertKey(tue) !== alertKey(thu), alertKey(tue));
}
eq('a uid with no start is unusable', alertKey({ uid: 'u@x' }), '');
eq('a start with no uid is unusable', alertKey({ start: iso(0) }), '');
eq('a uid with a garbage start is unusable', alertKey({ uid: 'u@x', start: 'next tuesday' }), '');
ok('every kind of junk gives an empty key', GARBAGE.every((g) => alertKey(g) === ''));
eq('no argument at all gives an empty key', alertKey(), '');

section('isAlertable , what counts as a meeting');
eq('a timed meeting is alertable', isAlertable(ev('ev_1', 5 * MINUTE)), true);
eq('an all-day event is not', isAlertable(ev('ev_2', 5 * MINUTE, { allDay: true })), false);
eq('a missing start is not', isAlertable(ev('ev_3', 0, { start: null })), false);
eq('an undefined start is not', isAlertable(ev('ev_4', 0, { start: undefined })), false);
eq('a malformed start is not', isAlertable(ev('ev_5', 0, { start: 'next tuesday' })), false);
eq('an empty start is not', isAlertable(ev('ev_6', 0, { start: '' })), false);
eq('an epoch start is fine, since the caller may build one', isAlertable(ev('ev_7', 0, { start: NOW })), true);
eq(
  'a skipTitles match is refused',
  isAlertable(ev('ev_8', 5 * MINUTE, { title: 'Focus time' }), { skipTitles: /focus time/i }),
  false,
);
eq(
  'a skipTitles miss is kept',
  isAlertable(ev('ev_9', 5 * MINUTE), { skipTitles: /focus time/i }),
  true,
);
{
  // A /g regex keeps lastIndex between calls, so this is the check that the same
  // question asked twice gets the same answer.
  const sticky = /standup/gi;
  const daily = ev('ev_10', 5 * MINUTE, { title: 'Daily standup' });
  eq('a global skipTitles refuses the first time', isAlertable(daily, { skipTitles: sticky }), false);
  eq('and refuses the second time too', isAlertable(daily, { skipTitles: sticky }), false);
  eq('the caller regex is left unmoved', sticky.lastIndex, 0);
}
eq(
  'a skipTitles that is not a regex is ignored, not guessed at',
  isAlertable(ev('ev_11', 5 * MINUTE), { skipTitles: 'Casework' }),
  true,
);
eq('a lecture with no other attendee still alerts', isAlertable(ev('ev_12', 5 * MINUTE, { attendeeCount: 0, attendees: [] })), true);
eq('and so does a one-attendee invite', isAlertable(ev('ev_13', 5 * MINUTE, { attendeeCount: 1 })), true);
ok('every kind of junk is not alertable', GARBAGE.every((g) => isAlertable(g) === false));
eq('junk options do not break it', isAlertable(ev('ev_14', 5 * MINUTE), null), true);
eq('a string option bag does not break it', isAlertable(ev('ev_15', 5 * MINUTE), 'opts'), true);
eq('no arguments at all is false', isAlertable(), false);

section('pendingAlert , the lead window');
eq('a meeting exactly at the lead boundary alerts', idOf(pendingAlert([ev('ev_lead', MINUTE)], NOW)), 'ev_lead');
eq('and reports how far away it is', inMs(pendingAlert([ev('ev_lead', MINUTE)], NOW)), MINUTE);
eq('one millisecond further out is silent', pendingAlert([ev('ev_lead', MINUTE + 1)], NOW), null);
eq('thirty seconds away alerts', inMs(pendingAlert([ev('ev_soon', 30 * SECOND)], NOW)), 30 * SECOND);
eq('a meeting starting this instant alerts', inMs(pendingAlert([ev('ev_now', 0)], NOW)), 0);
eq('an hour away is silent', pendingAlert([ev('ev_later', 60 * MINUTE)], NOW), null);
eq(
  'a wider leadMs is honoured',
  idOf(pendingAlert([ev('ev_wide', 4 * MINUTE)], NOW, { leadMs: 5 * MINUTE })),
  'ev_wide',
);
eq(
  'a leadMs of zero still catches the start instant',
  idOf(pendingAlert([ev('ev_zero', 0)], NOW, { leadMs: 0 })),
  'ev_zero',
);

section('pendingAlert , the grace window');
eq(
  'a meeting five minutes under way still alerts',
  idOf(pendingAlert([ev('ev_late', -5 * MINUTE)], NOW)),
  'ev_late',
);
eq('and reports a negative startsInMs', inMs(pendingAlert([ev('ev_late', -5 * MINUTE)], NOW)), -5 * MINUTE);
eq('one millisecond past the grace is silent', pendingAlert([ev('ev_gone', -5 * MINUTE - 1)], NOW), null);
eq('two minutes under way alerts', inMs(pendingAlert([ev('ev_mid', -2 * MINUTE)], NOW)), -2 * MINUTE);
eq('an hour under way is silent', pendingAlert([ev('ev_old', -60 * MINUTE)], NOW), null);
eq(
  'a graceMs of zero drops anything already started',
  pendingAlert([ev('ev_past', -1)], NOW, { graceMs: 0 }),
  null,
);
eq(
  'but not the start instant itself',
  idOf(pendingAlert([ev('ev_on', 0)], NOW, { graceMs: 0 })),
  'ev_on',
);

section('pendingAlert , choosing between meetings');
{
  const many = [ev('ev_c', 45 * SECOND), ev('ev_a', 10 * SECOND), ev('ev_b', 30 * SECOND)];
  eq('the soonest of several wins', idOf(pendingAlert(many, NOW)), 'ev_a');
  eq('and its distance is reported, not the winner-by-order', inMs(pendingAlert(many, NOW)), 10 * SECOND);
}
eq(
  'a meeting already under way beats one about to start',
  idOf(pendingAlert([ev('ev_next', 30 * SECOND), ev('ev_running', -2 * MINUTE)], NOW)),
  'ev_running',
);
{
  const a = ev('ev_aaa', 30 * SECOND);
  const b = ev('ev_bbb', 30 * SECOND);
  eq('a tie is broken on the key', idOf(pendingAlert([a, b], NOW)), 'ev_aaa');
  eq('and the same way whatever the feed order', idOf(pendingAlert([b, a], NOW)), 'ev_aaa');
  eq('so ten calls agree', new Set(Array.from({ length: 10 }, () => idOf(pendingAlert([b, a], NOW)))).size, 1);
}
{
  const one = ev('ev_first', 10 * SECOND);
  const two = ev('ev_second', 30 * SECOND);
  eq('an alerted key is skipped', idOf(pendingAlert([one, two], NOW, { alerted: ['ev_first'] })), 'ev_second');
  eq('an alerted Set works the same', idOf(pendingAlert([one, two], NOW, { alerted: new Set(['ev_first']) })), 'ev_second');
  eq('with everything alerted there is nothing to say', pendingAlert([one, two], NOW, { alerted: ['ev_first', 'ev_second'] }), null);
  eq('an alerted list of junk is ignored', idOf(pendingAlert([one, two], NOW, { alerted: 'ev_first' })), 'ev_first');
}
eq(
  'an all-day event never wins, however close it is',
  idOf(pendingAlert([ev('ev_offsite', 5 * SECOND, { allDay: true }), ev('ev_real', 45 * SECOND)], NOW)),
  'ev_real',
);
eq(
  'a skipped title never wins either',
  idOf(pendingAlert(
    [ev('ev_focus', 5 * SECOND, { title: 'Focus time' }), ev('ev_real', 45 * SECOND)],
    NOW,
    { skipTitles: /^focus/i },
  )),
  'ev_real',
);
eq(
  'an event with no trackable key is never returned',
  pendingAlert([{ title: 'Anonymous', start: iso(30 * SECOND), allDay: false }], NOW),
  null,
);
eq(
  'and it does not block the trackable one behind it',
  idOf(pendingAlert([{ title: 'Anonymous', start: iso(10 * SECOND) }, ev('ev_real', 40 * SECOND)], NOW)),
  'ev_real',
);
{
  const real = ev('ev_real', 30 * SECOND);
  eq('the event handed back is the caller own object', pendingAlert([real], NOW).event === real, true);
}

section('pendingAlert , junk in, null out');
eq('a null calendar returns null', pendingAlert(null, NOW), null);
eq('an undefined calendar returns null', pendingAlert(undefined, NOW), null);
eq('a string calendar returns null', pendingAlert('not an array', NOW), null);
eq('a number calendar returns null', pendingAlert(42, NOW), null);
eq('an object calendar returns null', pendingAlert({ 0: ev('ev_1', 0) }, NOW), null);
eq('an empty calendar returns null', pendingAlert([], NOW), null);
eq('a nonsense now returns null', pendingAlert([ev('ev_1', 30 * SECOND)], 'not a date'), null);
eq('a NaN now returns null', pendingAlert([ev('ev_1', 30 * SECOND)], NaN), null);
eq('a missing now returns null', pendingAlert([ev('ev_1', 30 * SECOND)]), null);
eq('no arguments at all returns null', pendingAlert(), null);
eq('a Date now works', idOf(pendingAlert([ev('ev_1', 30 * SECOND)], new Date(NOW))), 'ev_1');
eq('an epoch now works', idOf(pendingAlert([ev('ev_1', 30 * SECOND)], NOW)), 'ev_1');
eq('junk options are ignored', idOf(pendingAlert([ev('ev_1', 30 * SECOND)], NOW, null)), 'ev_1');
eq('junk window sizes fall back to the defaults', idOf(pendingAlert([ev('ev_1', 30 * SECOND)], NOW, { leadMs: 'soon', graceMs: NaN })), 'ev_1');
eq('a negative leadMs is read as zero, not as the past', pendingAlert([ev('ev_1', 1)], NOW, { leadMs: -5 * MINUTE }), null);
eq(
  'junk entries are stepped over, not thrown on',
  idOf(pendingAlert(GARBAGE.concat([ev('ev_real', 20 * SECOND)]), NOW)),
  'ev_real',
);
eq(
  'and so is an event with a garbage start',
  idOf(pendingAlert([ev('ev_bad', 0, { start: 'whenever' }), ev('ev_real', 20 * SECOND)], NOW)),
  'ev_real',
);
ok('nothing in the junk table ever throws', GARBAGE.every((g) => {
  try {
    pendingAlert(g, g, g);
    pendingAlert([g], NOW, { alerted: g, skipTitles: g });
    return true;
  } catch {
    return false;
  }
}));

section('nextWakeMs , when to look again');
eq('an empty calendar waits the maximum', nextWakeMs([], NOW), 60 * SECOND);
eq('a meeting ten minutes out is clamped to the maximum', nextWakeMs([ev('ev_1', 10 * MINUTE)], NOW), 60 * SECOND);
eq('a lead moment ninety seconds out is returned as it stands', nextWakeMs([ev('ev_1', 90 * SECOND)], NOW), 30 * SECOND);
eq('a lead moment one second out is clamped to the minimum', nextWakeMs([ev('ev_1', 61 * SECOND)], NOW), 5 * SECOND);
eq(
  'a lead moment already passed is not waited for',
  nextWakeMs([ev('ev_1', 30 * SECOND)], NOW),
  60 * SECOND,
);
eq('nor is a meeting already under way', nextWakeMs([ev('ev_1', -2 * MINUTE)], NOW), 60 * SECOND);
eq(
  'the soonest lead moment of several wins',
  nextWakeMs([ev('ev_1', 10 * MINUTE), ev('ev_2', 90 * SECOND), ev('ev_3', 5 * MINUTE)], NOW),
  30 * SECOND,
);
eq('an all-day event is never worth waking for', nextWakeMs([ev('ev_1', 90 * SECOND, { allDay: true })], NOW), 60 * SECOND);
eq('nor is a skipped title', nextWakeMs([ev('ev_1', 90 * SECOND, { title: 'Focus time' })], NOW, { skipTitles: /^focus/i }), 60 * SECOND);
eq('nor is a garbage start', nextWakeMs([ev('ev_1', 0, { start: 'whenever' })], NOW), 60 * SECOND);
eq('a wider leadMs moves the wake earlier', nextWakeMs([ev('ev_1', 5 * MINUTE + 30 * SECOND)], NOW, { leadMs: 5 * MINUTE }), 30 * SECOND);

section('nextWakeMs , the clamp itself');
eq('a custom maximum is honoured', nextWakeMs([], NOW, { maxMs: 10 * SECOND }), 10 * SECOND);
eq('a custom minimum is honoured', nextWakeMs([ev('ev_1', 60 * SECOND + 500)], NOW, { minMs: SECOND }), SECOND);
eq(
  'a custom window is applied at the top end too',
  nextWakeMs([ev('ev_1', 10 * MINUTE)], NOW, { minMs: SECOND, maxMs: 10 * SECOND }),
  10 * SECOND,
);
eq('a maximum under the minimum reads as the minimum', nextWakeMs([], NOW, { minMs: 20 * SECOND, maxMs: 5 * SECOND }), 20 * SECOND);
eq('a minimum of zero still never returns zero', nextWakeMs([], NOW, { minMs: 0, maxMs: 0 }), 1);
eq('a negative minimum still never returns zero', nextWakeMs([ev('ev_1', 60 * SECOND + 1)], NOW, { minMs: -5000 }), 1);
eq('junk clamps fall back to the defaults', nextWakeMs([], NOW, { minMs: 'a while', maxMs: null }), 60 * SECOND);
eq('a null calendar waits the maximum', nextWakeMs(null, NOW), 60 * SECOND);
eq('a string calendar waits the maximum', nextWakeMs('not an array', NOW), 60 * SECOND);
eq('a nonsense now waits the maximum', nextWakeMs([ev('ev_1', 90 * SECOND)], 'not a date'), 60 * SECOND);
eq('and honours a custom maximum while doing it', nextWakeMs([ev('ev_1', 90 * SECOND)], NaN, { maxMs: 12345 }), 12345);
eq('no arguments at all waits the maximum', nextWakeMs(), 60 * SECOND);
{
  // The caller feeds this straight to setTimeout, so the only property that
  // really matters is that no input can ever produce a spin or a NaN.
  const nows = [NOW, new Date(NOW), 'not a date', NaN, null, undefined, 0];
  const calendars = [[], null, 'junk', 42, GARBAGE, [ev('ev_1', 90 * SECOND)], [ev('ev_2', 0, { start: 'x' })]];
  const options = [undefined, null, {}, { minMs: 0, maxMs: 0 }, { minMs: NaN, maxMs: NaN }, { leadMs: -1 }, 'opts'];
  let worst = Infinity;
  let bad = null;
  for (const n of nows) {
    for (const c of calendars) {
      for (const o of options) {
        const ms = nextWakeMs(c, n, o);
        if (!Number.isFinite(ms) || ms <= 0) bad = `${show(c)} / ${show(n)} , ${show(ms)}`;
        worst = Math.min(worst, ms);
      }
    }
  }
  ok('no combination of junk returns 0, a negative or NaN', bad === null, bad ?? '');
  ok('and the smallest answer is still a real delay', worst >= 1, String(worst));
}

/* ------------------------------------------------------------------ result */

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
