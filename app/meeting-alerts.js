/**
 * MIN · which meeting deserves a "starting soon" nudge, and when to look again.
 *
 * ZERO imports, for the same reason meeting-schema.js has none. This decides
 * things for the main process, which is where the Notification and the tray
 * live, and it also has to run under plain `node` in its own test. One import of
 * electron would make the test need an Electron binary; one import of the
 * calendar store would drag settings, the disk cache and the network into a file
 * that is arithmetic over plain objects. The events handed in are the ones
 * calendar-store.js already serialises for the renderer, so nothing here has to
 * know how a feed is parsed.
 *
 * WHY A POLL AND NOT ONE TIMER PER MEETING
 * setTimeout is not a clock. A laptop that suspends for two hours fires the
 * timers it slept through late, all at once, and a timer armed for 09:59 on a
 * calendar that was refreshed at 09:58 is armed against events that may since
 * have moved. So nothing here schedules anything: the caller asks pendingAlert
 * what is due at this instant and nextWakeMs how long it may sleep before asking
 * again. Every answer is recomputed from the current calendar, so a meeting that
 * was rescheduled, cancelled or already notified self-corrects on the next tick
 * instead of being locked into a timer nobody can see.
 *
 * WHY A GRACE WINDOW AND NOT JUST A LEAD
 * The lead moment is one instant, and this app is closed, asleep or mid-refresh
 * for plenty of them. A meeting that started four minutes ago is not a missed
 * alert, it is the moment the user most wants the prompt, because they are in it
 * and not recording. Past the grace the opposite is true: a notification for a
 * meeting half over is noise about something already lost, so the right move is
 * silence.
 *
 * Every export survives null, a non-array, a garbage timestamp and an "event"
 * that is a string, and none of them throw. This runs on a timer with no user
 * watching, and a throw there takes out the poll for the rest of the session.
 */

/* --------------------------------------------------------------- constants */

const DEFAULT_LEAD_MS = 60000;
const DEFAULT_GRACE_MS = 300000;
const DEFAULT_MIN_WAKE_MS = 5000;
const DEFAULT_MAX_WAKE_MS = 60000;

/* -------------------------------------------------------------- primitives */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The two time forms this app produces: the ISO string calendar-store.js writes
 * into a serialised event, and a millisecond epoch, which is what Date.now()
 * hands in for `now`. Anything else is refused rather than coerced, because
 * Date.parse('TBD') is NaN and every comparison against NaN is false, so a bad
 * start would quietly read as "not due yet" forever instead of as bad input.
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

/** A caller's window, in ms. A negative one is not a window, so it is zero. */
const windowMs = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;

/**
 * The keys already notified. A Set is used as it stands; an array is copied into
 * one so a session that has been running all day does not re-scan its whole
 * history for every event on every tick.
 */
function alertedKeys(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

/* -------------------------------------------------------------------- keys */

/**
 * A stable name for one occurrence, which is what "already notified" is recorded
 * against.
 *
 * The id comes first because calendar.js already derives it from the uid and the
 * occurrence's start, so the two Tuesdays of one weekly class are two ids and get
 * two alerts, which is the whole point. Falling back to uid plus start instant
 * rather than uid alone keeps that property for any caller building events by
 * hand: a key of uid alone would notify the first lecture of the term and then
 * stay silent until December.
 *
 * The empty string means "cannot be tracked", and pendingAlert refuses to notify
 * about one, because an untrackable event would be notified again on every tick.
 */
export function alertKey(event) {
  if (!isObj(event)) return '';

  const id = typeof event.id === 'string' ? event.id.trim() : '';
  if (id) return id;

  const uid = typeof event.uid === 'string' ? event.uid.trim() : '';
  const startMs = toMs(event.start);
  if (!uid || startMs === null) return '';
  return `${uid}|${startMs}`;
}

/* ------------------------------------------------------------ eligibility */

/**
 * Whether this is the kind of event that should ever raise a notification.
 *
 * @param {object} event
 * @param {object} [opts]
 * @param {RegExp} [opts.skipTitles]  titles the user does not want nudged
 */
export function isAlertable(event, opts = {}) {
  if (!isObj(event)) return false;
  const o = isObj(opts) ? opts : {};

  // An all-day event starts at local midnight, so a lead window would fire it at
  // 23:59 the night before. It is also the wrong kind of thing: "Out of office",
  // "Focus time" and a deadline on the calendar are not meetings anyone takes
  // notes in, and there is nothing to record.
  if (event.allDay === true) return false;

  // Without a readable start there is no instant to measure a lead against, and
  // guessing one would notify at a time that matches nothing on the calendar.
  if (toMs(event.start) === null) return false;

  // Used stateless. A /g or /y regex carries lastIndex between .test() calls, so
  // the same title would match, then not match, then match again, and the user
  // would be nudged about every other standup. Rebuilding from source and flags
  // leaves the caller's own regex untouched, which matters because the caller
  // holds it in settings and reuses it on every tick.
  const skip = o.skipTitles;
  if (skip instanceof RegExp) {
    const title = typeof event.title === 'string' ? event.title : '';
    if (new RegExp(skip.source, skip.flags.replace(/[gy]/g, '')).test(title)) return false;
  }

  // attendeeCount is deliberately NOT a filter. Granola drops anything under two
  // attendees as "not a real meeting", but the owner of this app records
  // university lectures, which come off his feed with an attendeeCount of 0 or 1,
  // and a solo-invite filter would make this feature invisible to the person it
  // was built for. A one-person calendar entry with a start time is a thing he
  // records, so it is a thing worth being told about.
  return true;
}

/* ------------------------------------------------------------------ alerts */

/**
 * The single meeting to notify about at this instant, or null.
 *
 * @param {object[]} events
 * @param {Date|number} now
 * @param {object} [opts]
 * @param {number} [opts.leadMs=60000]     how far ahead of the start to notify
 * @param {number} [opts.graceMs=300000]   how long after the start it is still worth it
 * @param {string[]|Set<string>} [opts.alerted]  keys already notified
 * @param {RegExp} [opts.skipTitles]
 * @returns {{event: object, startsInMs: number}|null}
 */
export function pendingAlert(events, now, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const nowMs = toMs(now);
  // With no readable instant there is nothing to be early or late for, and the
  // caller passing junk here is a bug that should be quiet rather than a storm of
  // notifications for every event on the calendar.
  if (nowMs === null || !Array.isArray(events)) return null;

  const leadMs = windowMs(o.leadMs, DEFAULT_LEAD_MS);
  const graceMs = windowMs(o.graceMs, DEFAULT_GRACE_MS);
  const alerted = alertedKeys(o.alerted);

  let best = null;

  for (const event of events) {
    if (!isAlertable(event, o)) continue;

    const key = alertKey(event);
    if (!key || alerted.has(key)) continue;

    const startsInMs = toMs(event.start) - nowMs;
    if (startsInMs > leadMs || startsInMs < -graceMs) continue;

    // Smallest startsInMs wins, which puts a meeting already under way ahead of
    // one that has not started. That is the right way round: the notes being
    // missed are the ones being spoken now. Equal instants fall back to the key
    // so two 10:00 meetings resolve to the same one on every tick, rather than
    // flipping with whatever order the feed happened to be written in.
    if (best === null
      || startsInMs < best.startsInMs
      || (startsInMs === best.startsInMs && key < best.key)) {
      best = { event, startsInMs, key };
    }
  }

  return best === null ? null : { event: best.event, startsInMs: best.startsInMs };
}

/**
 * How long the caller may sleep before asking again.
 *
 * @param {object[]} events
 * @param {Date|number} now
 * @param {object} [opts]
 * @param {number} [opts.leadMs=60000]
 * @param {number} [opts.minMs=5000]   never sleep less than this
 * @param {number} [opts.maxMs=60000]  never sleep more than this, so a calendar
 *                                     that refreshed underneath us is seen
 * @returns {number} always finite and greater than zero
 */
export function nextWakeMs(events, now, opts = {}) {
  const o = isObj(opts) ? opts : {};

  // The floor is one millisecond even when the caller asks for zero: this number
  // goes straight into setTimeout, and a 0 turns the poll into a loop that starves
  // everything else on the main thread. A max under the min is read as the min,
  // because honouring it would mean returning a sleep shorter than the floor.
  const minMs = Math.max(1, windowMs(o.minMs, DEFAULT_MIN_WAKE_MS));
  const maxMs = Math.max(minMs, windowMs(o.maxMs, DEFAULT_MAX_WAKE_MS));

  const nowMs = toMs(now);
  if (nowMs === null || !Array.isArray(events)) return maxMs;

  const leadMs = windowMs(o.leadMs, DEFAULT_LEAD_MS);

  let soonest = null;

  for (const event of events) {
    if (!isAlertable(event, o)) continue;

    const untilLead = toMs(event.start) - leadMs - nowMs;
    // A lead moment already behind us is not something to wait for. Whatever it
    // is owed, pendingAlert is answering for on this very tick, and treating it
    // as a wake of zero would busy-loop until the meeting aged out of the grace
    // window. Notified keys are not consulted either: the clamp keeps the poll
    // inside a minute regardless, so skipping them buys nothing, and a wake that
    // finds nothing to do costs one pass over an array.
    if (untilLead <= 0) continue;
    if (soonest === null || untilLead < soonest) soonest = untilLead;
  }

  if (soonest === null) return maxMs;
  return Math.min(Math.max(soonest, minMs), maxMs);
}
