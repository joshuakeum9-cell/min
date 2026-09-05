/**
 * MIN · the home screen: the agenda ("Coming up") and the meetings library.
 *
 * Everything rendered here is untrusted text. Event titles and attendee names
 * come from a calendar feed anyone can put anything into, and meeting titles come
 * from folders on disk that may have been edited by hand. So the DOM is built with
 * createElement and textContent only; there is no innerHTML in this file, and no
 * value from either source is ever used as markup or as an attribute name.
 *
 * The module holds the last fetched agenda and meeting list so the filter box can
 * narrow the list on every keystroke without a round trip to the main process.
 */

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ colours */

/**
 * Eight muted background/ink pairs for letter tiles and event rules. Titles are
 * hashed onto the palette so a meeting keeps the same colour every time it is
 * drawn, and a recurring meeting looks the same in the agenda and in the list.
 * The pairs are set inline (style-src allows it) so the tiles render correctly
 * even before the shell stylesheet learns about them; the tone-N class is there
 * for the stylesheet to refine.
 */
const PALETTE = [
  { bg: '#e7ecd2', ink: '#5b6f00' }, // olive, the app accent
  { bg: '#f1e6d0', ink: '#8a6a1f' }, // sand
  { bg: '#f3dfd4', ink: '#a3512e' }, // clay
  { bg: '#f1dde3', ink: '#9a4560' }, // rose
  { bg: '#e7dfee', ink: '#6b4c8c' }, // plum
  { bg: '#dde5ee', ink: '#3f5f80' }, // slate
  { bg: '#d9ebe6', ink: '#2f6f62' }, // teal
  { bg: '#e6e6df', ink: '#55554f' }, // stone
];

/** FNV-1a, the same family calendar.js uses for ids. Case-folded so "Standup" and "standup" match. */
function toneIndex(title) {
  const s = String(title ?? '').trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % PALETTE.length;
}

/* -------------------------------------------------------------- formatting */

/** "9:00 AM". Fixed to en-US because the contract shows this exact shape. */
const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
// Written out, not abbreviated: the agenda has room for it and "September"
// reads as a date where "Sep" reads as a code.
const MONTH_LONG = new Intl.DateTimeFormat('en-US', { month: 'long' });
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

function asDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clock(d) {
  return d ? CLOCK.format(d) : '';
}

function timeRange(start, end) {
  if (!start) return '';
  if (!end) return clock(start);
  // U+2013 en dash, the character for a range. Not U+2014, the em dash.
  return `${clock(start)} – ${clock(end)}`;
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "Today", "Yesterday", then "Wed, Sep 2" (with the year once it is not this year). */
function dayLabel(d, now = new Date()) {
  const today = startOfDay(now);
  const that = startOfDay(d);
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** Attendees arrive either as plain names or as {name,email}; a name is what we show. */
function attendeeNames(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => {
      if (typeof a === 'string') return a.trim();
      if (a && typeof a === 'object') return String(a.name || a.email || '').trim();
      return '';
    })
    .filter(Boolean);
}

/** "Ana Lima, Ben Ortiz +3", or "Me" for a meeting nobody else was invited to. */
function subtitleFor(meeting) {
  const names = attendeeNames(meeting?.attendees ?? meeting?.calendarEvent?.attendees);
  if (!names.length) return 'Me';
  const shown = names.slice(0, 2).join(', ');
  const rest = names.length - 2;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/* ----------------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A letter tile or a rule takes its colour from the title, never from the title's text. */
function paintTone(node, title) {
  const i = toneIndex(title);
  node.classList.add(`tone-${i}`);
  node.style.setProperty('--tone-bg', PALETTE[i].bg);
  node.style.setProperty('--tone-ink', PALETTE[i].ink);
  return i;
}

/** First letter of the first word that has one; a fallback glyph for titles that are all symbols. */
function initialOf(title) {
  const m = String(title ?? '').match(/\p{L}|\p{N}/u);
  return m ? m[0].toUpperCase() : '·';
}

/** Something that failed across IPC, reduced to one human line. Never a stack. */
function errorLine(err) {
  const raw = err?.message ?? (typeof err === 'string' ? err : '');
  const firstLine = String(raw).split('\n')[0]
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
  return firstLine || 'Something went wrong';
}

/* ------------------------------------------------------------------- state */

let api = null;
let navigate = () => {};
let meetings = [];          // newest first, as the library returns them
let agenda = [];            // last agenda groups from the main process
let calendarConfigured = false;
let calendarError = '';
let unsubscribeCalendar = null;
let calSeq = 0;             // each half has its own counter so a calendar push cannot
let listSeq = 0;            // discard an in-flight meetings load, or the reverse

/* ------------------------------------------------------------------ agenda */

/** Takes the ISO strings that cross IPC and gives the renderer real Dates. */
function normaliseAgenda(groups, now) {
  if (!Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const events = Array.isArray(g.events) ? g.events : [];
    const normalised = events.map((ev) => {
      const start = asDate(ev?.start);
      const end = asDate(ev?.end);
      return {
        id: String(ev?.id ?? ''),
        title: String(ev?.title || 'Untitled event'),
        start,
        end,
        allDay: Boolean(ev?.allDay),
        attendees: attendeeNames(ev?.attendees),
        attendeeCount: Number(ev?.attendeeCount) || 0,
        recurring: Boolean(ev?.recurring),
        inProgress: Boolean(start && end && start <= now && end > now),
        raw: ev,
      };
    });
    // The day key is the authority; the first event's start is the fallback for a
    // group whose key is somehow unreadable.
    let dayDate = null;
    if (typeof g.day === 'string') {
      const [y, m, d] = g.day.split('-').map(Number);
      if (y && m && d) dayDate = new Date(y, m - 1, d);
    }
    if (!dayDate) dayDate = normalised.find((e) => e.start)?.start ?? null;
    if (!dayDate) continue;
    out.push({
      date: startOfDay(dayDate),
      isToday: typeof g.isToday === 'boolean' ? g.isToday : sameLocalDay(dayDate, now),
      events: normalised,
    });
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

function renderDayHead(date, isToday) {
  const head = el('div', 'day-head');
  const numeral = el('span', 'day-num', String(date.getDate()));
  const stack = el('span', 'day-stack');
  // The month and today's dot share a line, so the dot reads as a mark on the
  // date rather than as a bullet floating beside the numeral.
  const monthRow = el('span', 'day-month-row');
  monthRow.append(el('span', 'day-month', MONTH_LONG.format(date)));
  if (isToday) {
    const dot = el('span', 'today-dot');
    dot.setAttribute('aria-label', 'Today');
    monthRow.append(dot);
  }
  stack.append(monthRow, el('span', 'day-weekday', WEEKDAY_SHORT.format(date)));
  head.append(numeral, stack);
  if (isToday) head.classList.add('today');
  return head;
}

function renderEventRow(ev) {
  const row = el('div', 'event');
  if (ev.inProgress) row.classList.add('now');
  paintTone(row, ev.title);

  const rule = el('span', 'event-rule');
  const body = el('div', 'event-body');
  const titleLine = el('div', 'event-title-line');
  titleLine.append(el('span', 'event-title', ev.title));
  if (ev.inProgress) titleLine.append(el('span', 'now-label', 'Now'));
  body.append(titleLine);

  const when = el('span', 'event-time mono');
  when.textContent = ev.allDay ? 'All day' : timeRange(ev.start, ev.end);
  body.append(when);

  row.append(rule, body);
  row.title = ev.attendeeCount > 1 ? `${ev.attendeeCount} attendees` : '';
  return row;
}

function renderAgenda() {
  const root = $('comingUp');
  if (!root) return;
  clear(root);

  if (!calendarConfigured) {
    const row = el('button', 'agenda-empty link');
    row.type = 'button';
    row.textContent = 'Connect a calendar in Settings to see your meetings here';
    row.addEventListener('click', () => navigate('settings'));
    root.append(row);
    return;
  }

  if (calendarError) {
    root.append(el('p', 'agenda-empty muted', `Calendar could not be loaded: ${calendarError}`));
    if (!agenda.length) return;
  }

  if (!agenda.length) {
    root.append(el('p', 'agenda-empty muted', 'Nothing on your calendar'));
    return;
  }

  const now = new Date();
  const groups = agenda.slice();
  // Today always leads the card, even with nothing on it, so the "No events
  // today" line sits under today's numeral where the eye expects it.
  if (!groups.some((g) => g.isToday)) {
    groups.unshift({ date: startOfDay(now), isToday: true, events: [] });
    groups.sort((a, b) => a.date - b.date);
  }

  for (const g of groups) {
    const day = el('div', 'agenda-day');
    if (g.isToday) day.classList.add('today');
    day.append(renderDayHead(g.date, g.isToday));
    // The divider between the date and the events. Its own element because it
    // is a grid track, not a border on either neighbour.
    day.append(el('span', 'agenda-rule'));
    const list = el('div', 'agenda-events');
    if (!g.events.length) {
      list.append(el('p', 'agenda-empty muted', 'No events today'));
    } else {
      for (const ev of g.events) list.append(renderEventRow(ev));
    }
    day.append(list);
    root.append(day);
  }
}

/* --------------------------------------------------------------- note list */

function renderNoteRow(m) {
  const row = el('div', 'note-row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const tile = el('span', 'tile', initialOf(m.title));
  paintTone(tile, m.title);

  const body = el('div', 'note-body');
  body.append(el('span', 'note-title', m.title || 'Untitled meeting'));
  body.append(el('span', 'note-sub', subtitleFor(m)));

  const started = asDate(m.startedAt);
  const time = el('span', 'note-time mono', clock(started));

  row.append(tile, body, time);

  const open = () => navigate('note', m);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return row;
}

/** The library's order is newest first by folder name; sort by startedAt to be sure. */
function sortedMeetings(list) {
  return list.slice().sort((a, b) => {
    const ta = asDate(a.startedAt)?.getTime() ?? -Infinity;
    const tb = asDate(b.startedAt)?.getTime() ?? -Infinity;
    return tb - ta;
  });
}

function matchesFilter(m, q) {
  if (!q) return true;
  const hay = `${m.title ?? ''} ${subtitleFor(m)}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
}

function renderNoteList() {
  const root = $('noteList');
  if (!root) return;
  clear(root);

  const q = ($('ask')?.value ?? '').trim().toLowerCase();
  const rows = sortedMeetings(meetings).filter((m) => matchesFilter(m, q));

  if (!rows.length) {
    const empty = el('div', 'list-empty');
    if (q) {
      empty.append(el('p', 'muted', 'No notes match. Press Enter to search inside transcripts too.'));
    } else {
      empty.append(el('p', 'muted', 'No notes yet.'));
      const hint = el('p', 'muted');
      hint.append('Press ');
      hint.append(el('kbd', null, '+ New note'));
      hint.append(' to start your first meeting.');
      empty.append(hint);
    }
    root.append(empty);
    return;
  }

  const now = new Date();
  let currentLabel = null;
  let group = null;
  for (const m of rows) {
    const d = asDate(m.startedAt);
    const label = d ? dayLabel(d, now) : 'Undated';
    if (label !== currentLabel) {
      currentLabel = label;
      group = el('section', 'note-day');
      group.append(el('h2', 'note-day-label', label));
      root.append(group);
    }
    group.append(renderNoteRow(m));
  }
}

/* ----------------------------------------------------------------- loading */

async function loadCalendar(seq) {
  let configured = false;
  try {
    const settings = await api.settingsGet?.();
    configured = Boolean(settings?.calendarUrl && String(settings.calendarUrl).trim());
  } catch {
    // No settings bridge yet: assume configured so a real error can still show.
    configured = true;
  }
  if (seq !== calSeq) return;
  calendarConfigured = configured;
  if (!configured) {
    agenda = [];
    calendarError = '';
    renderAgenda();
    return;
  }
  try {
    const groups = await api.calendarUpcoming({ days: 7 });
    if (seq !== calSeq) return;
    agenda = normaliseAgenda(groups, new Date());
    calendarError = '';
  } catch (err) {
    if (seq !== calSeq) return;
    calendarError = errorLine(err);
  }
  renderAgenda();
}

async function loadMeetings(seq) {
  try {
    const list = await api.listMeetings();
    if (seq !== listSeq) return;
    meetings = Array.isArray(list) ? list : [];
  } catch {
    if (seq !== listSeq) return;
    meetings = [];
  }
  renderNoteList();
}

/** Re-fetch both halves. Safe to call whenever the home view is shown. */
export async function refreshHome() {
  if (!api) return;
  await Promise.all([loadCalendar(++calSeq), loadMeetings(++listSeq)]);
}

/* ----------------------------------------------------------------- ask bar */

/** Enter runs FTS in the main process and opens the top hit. The hit carries a dir. */
async function runSearch(q) {
  if (!q) return;
  let hits = [];
  try {
    hits = await api.search(q);
  } catch {
    hits = [];
  }
  const top = Array.isArray(hits) ? hits[0] : null;
  if (!top) {
    // Fall back to whatever the client-side filter left, so Enter is never a dead key.
    const visible = sortedMeetings(meetings).filter((m) => matchesFilter(m, q.toLowerCase()));
    if (visible[0]) navigate('note', visible[0]);
    return;
  }
  const meeting = meetings.find((m) => m.dir === top.dir) ?? top;
  navigate('note', meeting);
}

function wireAskBar() {
  const ask = $('ask');
  if (ask) {
    ask.addEventListener('input', renderNoteList);
    ask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch(ask.value.trim());
      }
    });
  }
  $('listTodos')?.addEventListener('click', () => {
    const newest = sortedMeetings(meetings)[0];
    if (newest) navigate('note', newest);
  });
}

/* -------------------------------------------------------------------- init */

/**
 * @param {{api: object, navigate: (view: string, payload?: any) => void}} opts
 *   api is window.api; navigate is the router's show(), given rather than
 *   imported so this module has no opinion about how views are switched.
 */
export function initHome(opts = {}) {
  api = opts.api ?? window.api;
  navigate = typeof opts.navigate === 'function' ? opts.navigate : () => {};

  wireAskBar();

  // A second init (hot reload, tests) must not stack listeners on the bridge.
  if (typeof unsubscribeCalendar === 'function') unsubscribeCalendar();
  unsubscribeCalendar = null;
  if (typeof api?.onCalendarUpdated === 'function') {
    unsubscribeCalendar = api.onCalendarUpdated((payload) => {
      // The store may report a failed refresh here; the last good agenda stays
      // on screen with the error line above it rather than blanking the card.
      if (payload && typeof payload === 'object' && payload.ok === false) {
        calendarError = errorLine(payload.error ?? payload);
        renderAgenda();
        return;
      }
      loadCalendar(++calSeq);
    });
  }

  return refreshHome();
}
