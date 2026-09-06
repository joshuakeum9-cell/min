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
/*
 * The agenda shows a fortnight, five meetings at a time, which is the shape
 * Granola documents: "the desktop app shows the next 14 days", and "we show 5
 * meetings to keep the app tidy, but you can use the forward and back arrows to
 * page through additional meetings".
 *
 * Paging is by MEETING, not by day, so the card is the same height whether a
 * day holds one meeting or nine. That is what stops a busy week from growing an
 * agenda taller than the window.
 */
const AGENDA_DAYS = 14;
const AGENDA_PAGE = 5;
let agendaPage = 0;         // 0 is today onwards

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
      // These fields and no more. Clicking a row hands this object to the note
      // as prefill.calendarEvent, and recording that note saves it into
      // meeting.json, so the event as it arrived over IPC used to land on disk
      // nested inside its own copy. Nothing ever read it back.
      return {
        id: String(ev?.id ?? ''),
        // Carried explicitly because it used to reach disk only inside `raw`:
        // without it library.js resolves calendarUid to null for a note started
        // from a Coming up row, while one started from the prompt has it.
        uid: String(ev?.uid ?? ''),
        title: String(ev?.title || 'Untitled event'),
        start,
        end,
        allDay: Boolean(ev?.allDay),
        attendees: attendeeNames(ev?.attendees),
        attendeeCount: Number(ev?.attendeeCount) || 0,
        recurring: Boolean(ev?.recurring),
        inProgress: Boolean(start && end && start <= now && end > now),
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

/** How many meetings the whole fortnight holds. */
function countEvents(groups) {
  let n = 0;
  for (const g of groups) n += g.events.length;
  return n;
}

/**
 * Empty the pager, and report which of its controls the keyboard was on so the
 * rebuild can hand focus back.
 *
 * Called from the top of renderAgenda rather than from renderAgendaNav, because
 * the pager is a sibling of the agenda card and not a child of it: the three
 * states that return before drawing a pager would otherwise leave the last one
 * on screen, enabled, steering an agenda that is no longer there.
 */
function clearAgendaNav() {
  const nav = $('agendaNav');
  if (!nav) return null;
  const focused = nav.contains(document.activeElement)
    ? document.activeElement.dataset.nav ?? null
    : null;
  clear(nav);
  return focused;
}

/**
 * Back, forward and Today, beside the heading.
 *
 * Rebuilt on every render rather than kept and mutated, because the page count
 * changes whenever the calendar does and there is nothing here worth the
 * bookkeeping of a partial update. `focused` is what clearAgendaNav found on
 * the pager it emptied, which is how the rebuild keeps the keyboard's place.
 */
function renderAgendaNav(pages, total, focused) {
  const nav = $('agendaNav');
  if (!nav) return;
  if (total <= AGENDA_PAGE) return;   // one page: nothing to steer

  const go = (to) => { agendaPage = to; renderAgenda(); };
  const buttons = new Map();

  if (agendaPage > 0) {
    const today = el('button', 'agenda-nav-today', 'Today');
    today.type = 'button';
    today.title = 'Back to today';
    today.dataset.nav = 'today';
    today.addEventListener('click', () => go(0));
    nav.append(today);
    buttons.set('today', today);
  }

  const arrow = (key, label, glyph, to, enabled) => {
    const b = el('button', 'agenda-nav-btn', glyph);
    b.type = 'button';
    b.title = label;
    b.dataset.nav = key;
    b.setAttribute('aria-label', label);
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', () => go(to));
    nav.append(b);
    buttons.set(key, b);
  };
  arrow('prev', 'Earlier meetings', '\u2039', agendaPage - 1, agendaPage > 0);
  arrow('next', 'Later meetings', '\u203a', agendaPage + 1, agendaPage < pages - 1);

  /*
   * Give focus back to the button that was just pressed. At either end of the
   * range that button is gone (Today, once page one is showing) or disabled
   * (the arrow that ran out of pages), so focus goes to its neighbour, which is
   * the one still worth pressing. Paging must not cost a tab back through the
   * whole page each time.
   */
  if (!focused) return;
  const nextBest = {
    today: ['today', 'next', 'prev'],
    prev: ['prev', 'next', 'today'],
    next: ['next', 'prev', 'today'],
  };
  for (const key of nextBest[focused] ?? []) {
    const b = buttons.get(key);
    if (b && !b.disabled) { b.focus(); return; }
  }
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

  /*
   * The row is how a note gets attached to a meeting. Granola: "Clicking on one
   * of these meetings will create a note for that meeting". The note opens
   * carrying the event, so its title and attendees are the meeting's, and
   * pressing Record then keeps them.
   *
   * It does NOT start recording by itself. Opening a note days early to jot
   * down pre-meeting thoughts is the other half of what this click is for, and
   * a click that silently switched on the microphone would make that unusable.
   */
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.title = ev.attendeeCount > 1 ? `${ev.attendeeCount} attendees` : 'Open a note for this meeting';
  const open = () => navigate('note', { prefill: { calendarEvent: ev, title: ev.title } });
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}

function renderAgenda() {
  const root = $('comingUp');
  if (!root) return;
  clear(root);
  const navFocus = clearAgendaNav();

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

  /*
   * Flatten to a list of meetings, take this page's five, then rebuild the day
   * groups around only those. Grouping after slicing is what keeps a page five
   * meetings tall regardless of how they fall across days.
   */
  const flat = [];
  for (const g of agenda) for (const ev of g.events) flat.push({ g, ev });
  const total = flat.length;
  const pages = Math.max(1, Math.ceil(total / AGENDA_PAGE));
  agendaPage = Math.min(Math.max(0, agendaPage), pages - 1);
  const slice = flat.slice(agendaPage * AGENDA_PAGE, agendaPage * AGENDA_PAGE + AGENDA_PAGE);

  const byDay = new Map();
  for (const { g, ev } of slice) {
    if (!byDay.has(g)) byDay.set(g, { date: g.date, isToday: g.isToday, events: [] });
    byDay.get(g).events.push(ev);
  }
  const groups = [...byDay.values()];

  // Today leads the FIRST page even with nothing on it, so the "No events
  // today" line sits under today's numeral where the eye expects it. On later
  // pages it would be a lie: those days are elsewhere in the fortnight.
  if (agendaPage === 0 && !groups.some((g) => g.isToday)) {
    groups.unshift({ date: startOfDay(now), isToday: true, events: [] });
    groups.sort((a, b) => a.date - b.date);
  }

  renderAgendaNav(pages, total, navFocus);

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

  /*
   * The overflow button. Hidden until the row is hovered or something in it has
   * focus, so a list of notes stays a list of notes; the CSS does that, not
   * JavaScript, so it cannot get out of step with the pointer.
   *
   * It is a real button with a label rather than a decorated span, because it
   * is the only route to deleting a meeting and that must be reachable from the
   * keyboard.
   */
  const more = el('button', 'row-more');
  more.type = 'button';
  more.title = 'More';
  more.setAttribute('aria-label', `More actions for ${m.title || 'this meeting'}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.textContent = '\u22ef';
  more.addEventListener('click', (e) => {
    e.stopPropagation();   // never open the note as well
    openRowMenu(row, more, m);
  });
  more.addEventListener('keydown', (e) => e.stopPropagation());

  row.append(tile, body, time, more);

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

/* ------------------------------------------------------------- row menu */

// One menu open at a time, tracked here rather than by walking the DOM, so
// closing is a single call whatever opened it.
let openMenu = null;

function closeRowMenu() {
  if (!openMenu) return;
  const { menu, button, onDoc, onKey } = openMenu;
  openMenu = null;
  document.removeEventListener('mousedown', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  menu.remove();
  button.setAttribute('aria-expanded', 'false');
}

/**
 * The overflow menu for one note.
 *
 * Anchored inside the row, which keeps it with the row when the list scrolls,
 * and closed by anything that means "I am done": a click elsewhere, Escape, or
 * opening another one. mousedown rather than click for the outside handler,
 * because a click that starts outside and ends inside should still close it.
 */
function openRowMenu(row, button, m) {
  const wasOpen = openMenu?.button === button;
  closeRowMenu();
  if (wasOpen) return;   // a second press on the same button closes it

  const menu = el('div', 'row-menu');
  menu.setAttribute('role', 'menu');

  const item = (label, cls, run) => {
    const b = el('button', `row-menu-item${cls ? ' ' + cls : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRowMenu();
      run();
    });
    menu.append(b);
    return b;
  };

  item('Move to trash', 'danger', () => trashMeeting(m, row));

  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== button) closeRowMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeRowMenu(); button.focus(); }
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);

  row.append(menu);
  button.setAttribute('aria-expanded', 'true');
  openMenu = { menu, button, onDoc, onKey };
  menu.querySelector('.row-menu-item')?.focus();
}

/**
 * Send one meeting to the recycle bin and drop it from the list.
 *
 * No confirmation dialog on purpose: the operating system's own trash IS the
 * confirmation, the row says where it went, and a modal for something this
 * reversible is the kind of friction that trains people to click through
 * dialogs that matter.
 *
 * `row` is the element the menu was opened from, kept only to know where in the
 * list the gap will be.
 */
async function trashMeeting(m, row) {
  if (!m?.dir || typeof api?.trashMeeting !== 'function') return;
  try {
    /*
     * Read the row's place AFTER the await, not before. closeRowMenu has already
     * dropped focus to the body by this point, and the list can repaint while
     * the trash is in flight, which makes an index taken beforehand point at a
     * different meeting.
     */
    const index = [...document.querySelectorAll('#noteList .note-row')].indexOf(row);
    await api.trashMeeting(m.dir);
    meetings = meetings.filter((x) => x.dir !== m.dir);
    renderNoteList();
    /*
     * Focus follows the deletion: the row that takes the gap, the last row when
     * the trashed one was last, the filter box when nothing is left. Without it
     * focus falls to the body and deleting a second note costs a tab through the
     * whole page.
     *
     * Only from the body, though. The trash is a round trip to the shell, and a
     * user who clicked into the search box while it ran must not have the caret
     * yanked out from under them when it returns.
     */
    if (index >= 0 && document.activeElement === document.body) {
      const rows = document.querySelectorAll('#noteList .note-row');
      (rows[Math.min(index, rows.length - 1)] ?? $('ask'))?.focus();
    }
    homeStatus(`"${m.title || 'Untitled meeting'}" moved to the recycle bin.`, 'good');
  } catch (err) {
    homeStatus('Could not move it to the trash: ' + (err?.message ?? err), 'warn');
  }
}

/*
 * Home's own status line. The note bar's strip lives inside the note view, so
 * anything reported from here went nowhere at all: initHome was even handed an
 * onStatus callback that wrote to it and was never called. Clears itself,
 * because a message about a row that is already gone stops being true.
 */
let homeStatusTimer = null;

function homeStatus(text, cls = '') {
  const el2 = document.getElementById('homeStatus');
  if (!el2) return;
  clearTimeout(homeStatusTimer);
  el2.className = cls;
  el2.textContent = text;
  if (text) homeStatusTimer = setTimeout(() => { el2.textContent = ''; el2.className = ''; }, 6000);
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
  // Nothing but closeRowMenu takes the menu's document listeners off again, and
  // this repaints under an open menu on every keystroke in the filter box and on
  // every refresh. Detaching the menu alone would leave its capture-phase
  // keydown to swallow the next Escape on behalf of a menu that is gone.
  closeRowMenu();
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
    // Fourteen, which is the horizon Granola's desktop app documents for its
    // own Coming up. The store caps the request at its 60-day window anyway.
    const groups = await api.calendarUpcoming({ days: AGENDA_DAYS });
    if (seq !== calSeq) return;
    agenda = normaliseAgenda(groups, new Date());
    // A refresh can shorten the list under the user's feet.
    agendaPage = Math.min(agendaPage, Math.max(0, Math.ceil(countEvents(agenda) / AGENDA_PAGE) - 1));
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
