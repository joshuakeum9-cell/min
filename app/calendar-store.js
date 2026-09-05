/**
 * MIN, the calendar store: the main process's copy of the user's calendar.
 *
 * calendar.js knows how to read a feed; this module decides when. It holds the
 * parsed events in memory, re-fetches on the interval from settings, and keeps
 * a cache on disk so the agenda is on screen the instant the window opens
 * rather than after the first network round trip.
 *
 * What is cached is the expanded window (a month back, two months forward) as
 * flat, single occurrences, not the parsed masters. Parsed events carry Dates,
 * parsed RRULEs and cross-references (an override points at its master) that do
 * not survive JSON, and fetchCalendar does not hand back the text they came
 * from. A flat occurrence with no rule survives JSON with two Dates to restore,
 * and calendar.js's upcoming() and eventAt() treat a rule-less event as itself,
 * so the cached window renders through exactly the same code as live data.
 *
 * The cache is keyed by a hash of the calendar URL, so a cache written for one
 * calendar is never shown after the user pastes a different one.
 *
 * The URL is a bearer secret. It is read from settings at the moment of each
 * fetch and never stored, logged or included in any result this module returns;
 * fetchCalendar's own error strings name only the host.
 *
 * No Electron imports, so this runs under plain node.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchCalendar, expandAll, upcoming, eventAt } from './calendar.js';

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

// A month back covers a meeting recorded late and titled from a past event; two
// months forward is further than the home screen ever looks.
const WINDOW_BACK_DAYS = 30;
const WINDOW_FORWARD_DAYS = 60;

const CACHE_SCHEMA = 1;
const FETCH_TIMEOUT_MS = 15000;

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

/** Only the hash ever touches disk, and it cannot be turned back into the URL. */
function keyFor(url) {
  return createHash('sha256').update(String(url)).digest('hex');
}

function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ------------------------------------------------------------- occurrences */

function windowFor(t) {
  return [new Date(t - WINDOW_BACK_DAYS * DAY_MS), new Date(t + WINDOW_FORWARD_DAYS * DAY_MS)];
}

/**
 * One expanded occurrence as JSON. The rule is dropped on purpose: the
 * occurrence already IS one instance, and keeping the rule would make the
 * loader expand it again. The `rrule` string stays only because toAgendaEvent
 * reads `recurring` off it.
 */
function freeze(occ) {
  return {
    uid: occ.uid,
    summary: occ.summary,
    location: occ.location,
    status: occ.status,
    organizer: occ.organizer,
    attendees: occ.attendees,
    start: iso(occ.start),
    end: iso(occ.end),
    allDay: Boolean(occ.allDay),
    tzid: occ.tzid ?? null,
    rrule: occ.rrule ?? null,
    startWallMs: occ.startWallMs,
    endWallMs: occ.endWallMs,
  };
}

/** The inverse of freeze: a rule-less event expandRecurring yields once, as itself. */
function thaw(row) {
  if (!row || typeof row !== 'object') return null;
  const start = new Date(row.start);
  const end = new Date(row.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    uid: String(row.uid ?? ''),
    summary: String(row.summary ?? ''),
    description: '',
    location: String(row.location ?? ''),
    status: row.status ?? null,
    sequence: 0,
    transparency: null,
    organizer: row.organizer ?? null,
    attendees: Array.isArray(row.attendees) ? row.attendees : [],
    start,
    end,
    allDay: Boolean(row.allDay),
    tzid: row.tzid ?? null,
    tzUnknown: false,
    rrule: row.rrule ?? null,
    rruleParts: null,
    rruleUnsupported: false,
    rruleUnsupportedReason: null,
    exdates: [],
    recurrenceId: null,
    overrides: [],
    startWallMs: row.startWallMs,
    endWallMs: row.endWallMs,
  };
}

/**
 * Attendee display strings. The agenda shape from calendar.js carries only a
 * count, and the home rows want names, so they are read off the occurrence.
 */
function attendeeNames(occ) {
  const list = Array.isArray(occ?.attendees) ? occ.attendees : [];
  const out = [];
  for (const a of list) {
    const label = (a?.name || a?.email || '').trim();
    if (label) out.push(label);
    if (out.length >= 50) break;
  }
  return out;
}

/** Everything the renderer sees, with Dates as ISO strings. */
function serialiseEvent(ev, names) {
  return {
    id: ev.id,
    uid: ev.uid,
    title: ev.title,
    start: iso(ev.start),
    end: iso(ev.end),
    allDay: Boolean(ev.allDay),
    location: ev.location || '',
    attendees: names,
    attendeeCount: ev.attendeeCount ?? names.length,
    recurring: Boolean(ev.recurring),
    inProgress: Boolean(ev.inProgress),
  };
}

/* ------------------------------------------------------------------- store */

/**
 * @param {object} opts
 * @param {{get(key:string):any}} opts.settings   the settings store; read live, never copied
 * @param {string}   opts.cachePath               JSON file in userData
 * @param {function} [opts.onUpdated]             ({ok,error,fetchedAt,count}) after every refresh
 * @param {function} [opts.fetch]                 test seam, defaults to calendar.fetchCalendar
 * @param {function} [opts.now]                   test seam, defaults to Date.now
 */
export function createCalendarStore({ settings, cachePath, onUpdated, fetch = fetchCalendar, now = Date.now }) {
  let events = [];
  let fetchedAt = null;
  let lastError = null;
  let fromCache = false;
  let timer = null;
  let inFlight = null;

  const url = () => String(settings.get('calendarUrl') ?? '').trim();

  /** Occurrences in the working window: the number "Test connection" reports. */
  function occurrencesInWindow() {
    const [from, to] = windowFor(now());
    return expandAll(events, from, to).filter((occ) => occ.status !== 'CANCELLED');
  }

  function summary(ok, error) {
    return { ok, error, fetchedAt: iso(fetchedAt), count: occurrencesInWindow().length, fromCache };
  }

  /* .............................................................. cache */

  async function writeCache(key) {
    const record = {
      schema: CACHE_SCHEMA,
      key,
      fetchedAt: iso(fetchedAt),
      occurrences: occurrencesInWindow().map(freeze),
    };
    // Write beside and rename, so a crash mid-write cannot leave a truncated
    // file that parses as an empty calendar.
    const tmp = `${cachePath}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, cachePath);
  }

  /** Load whatever the last run left, if it belongs to the current URL. */
  async function loadCache() {
    const current = url();
    if (!current) return false;
    let record;
    try {
      record = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    } catch {
      return false; // first run, or unreadable; the refresh that follows rewrites it
    }
    if (!record || record.schema !== CACHE_SCHEMA || record.key !== keyFor(current)) return false;
    if (!Array.isArray(record.occurrences)) return false;
    events = record.occurrences.map(thaw).filter(Boolean);
    fetchedAt = record.fetchedAt ? new Date(record.fetchedAt) : null;
    fromCache = true;
    return true;
  }

  /* ............................................................ refresh */

  /**
   * Fetch, parse, keep, cache. Never throws. Concurrent calls share one fetch,
   * so a Test connection click during the interval tick does not hit the
   * provider twice.
   */
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const current = url();
      if (!current) {
        // Disconnected: forget everything, including the cache on disk, so a
        // removed calendar does not come back on the next launch.
        events = [];
        fetchedAt = null;
        lastError = null;
        fromCache = false;
        await fsp.rm(cachePath, { force: true }).catch(() => {});
        const result = { ok: false, error: 'No calendar connected.', fetchedAt: null, count: 0, fromCache: false };
        onUpdated?.(result);
        return result;
      }

      const r = await fetch(current, { timeoutMs: FETCH_TIMEOUT_MS });
      if (!r.ok) {
        // Keep the last good events on a failure rather than blanking the
        // agenda every time the laptop is off wifi.
        lastError = r.error;
        const result = summary(false, r.error);
        onUpdated?.(result);
        return result;
      }
      events = r.events;
      fetchedAt = r.fetchedAt instanceof Date ? r.fetchedAt : new Date(now());
      lastError = null;
      fromCache = false;
      await writeCache(keyFor(current)).catch(() => { /* the cache is a convenience, not the record */ });
      const result = summary(true, null);
      onUpdated?.(result);
      return result;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  /* ................................................................ read */

  function upcomingDays(days) {
    const from = new Date(now());
    const span = Math.max(1, Math.min(WINDOW_FORWARD_DAYS, Math.floor(Number(days)) || 7));
    const groups = upcoming(events, { from, days: span });

    // Names live on the occurrences, not on the agenda rows, so expand once
    // more over the same window and join on uid plus start instant, which is
    // what the agenda row's id is derived from too.
    const windowEnd = new Date(from.getFullYear(), from.getMonth(), from.getDate() + span);
    const names = new Map();
    for (const occ of expandAll(events, from, windowEnd)) {
      names.set(`${occ.uid}|${occ.start.getTime()}`, attendeeNames(occ));
    }

    const todayKey = localDayKey(from);
    return groups.map((g) => ({
      day: g.date,
      label: g.label,
      isToday: g.date === todayKey,
      events: g.events.map((ev) =>
        serialiseEvent(ev, names.get(`${ev.uid}|${new Date(ev.start).getTime()}`) ?? [])
      ),
    }));
  }

  function eventNow(when = new Date(now())) {
    const ev = eventAt(events, when);
    if (!ev) return null;
    const startMs = new Date(ev.start).getTime();
    // eventAt has already chosen the occurrence; find the same one for its names.
    const occ = expandAll(events, new Date(startMs - 1), new Date(startMs + 1))
      .find((o) => o.uid === ev.uid && o.start.getTime() === startMs);
    return serialiseEvent(ev, attendeeNames(occ));
  }

  /* ........................................................... interval */

  function intervalMs() {
    const minutes = Number(settings.get('calendarRefreshMinutes'));
    return Math.max(1, Math.min(24 * 60, Number.isFinite(minutes) ? minutes : 15)) * MINUTE_MS;
  }

  /**
   * Load the cache, then fetch, then keep fetching. Calling it again re-arms the
   * interval, which is how a changed refresh setting takes effect.
   */
  async function start() {
    stop();
    if (await loadCache()) onUpdated?.(summary(true, null));
    timer = setInterval(() => { refresh(); }, intervalMs());
    timer.unref?.();
    return refresh();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    refresh,
    upcoming: upcomingDays,
    eventNow,
    start,
    stop,
    /** For the settings pane: when the feed was last read, and the last error if any. */
    status: () => ({ connected: Boolean(url()), ...summary(!lastError, lastError) }),
  };
}
