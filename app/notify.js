/**
 * The meeting popup's own renderer. Main pushes one card in, of one of two
 * kinds: a calendar meeting about to start, or a meeting detected because
 * another app opened the microphone. What goes back is a command: 'take' and
 * 'dismiss' for either kind, the three menu items for a detected one, and
 * 'menu' each time the menu opens or closes, carrying the height the card now
 * needs so main can grow and shrink a window that is sized to it. It holds no
 * calendar or microphone state of its own, because the source of truth for
 * both is in main, which is also what decides this window should exist at all.
 *
 * window.notify, the popup window's preload bridge, is read defensively so the
 * page renders the static card in the markup rather than throwing if it is
 * missing, which is also how it looks loaded straight in a browser for styling
 * work.
 */

const bridge = typeof window !== 'undefined' ? window.notify : null;
const onMeeting = bridge && typeof bridge.onMeeting === 'function' ? bridge.onMeeting : null;
const sendCommand = bridge && typeof bridge.send === 'function' ? bridge.send.bind(bridge) : null;

const card = document.getElementById('card');
const whenEl = document.getElementById('notifyWhen');
const titleEl = document.getElementById('notifyTitle');
const timeEl = document.getElementById('notifyTime');
const take = document.getElementById('notifyTake');
const dismiss = document.getElementById('notifyDismiss');
const more = document.getElementById('notifyMore');
const menu = document.getElementById('notifyMenu');
const muteApp = document.getElementById('notifyMuteApp');

/* -------------------------------------------------------------- formatting */

/** "9:00 AM". Fixed to en-US, the same formatter and shape the agenda uses. */
const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

const MINUTE_MS = 60000;

// Same shape as home.js. Main sends ISO strings today, but a Date survives the
// structured clone an IPC push goes through, so both have to land here.
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
  // An all-day or malformed event can arrive with no end. Half a range still
  // tells you when it starts, which is the part this window is about.
  if (!end) return clock(start);
  // U+2013 en dash, the character for a range. Not U+2014, the em dash.
  return `${clock(start)} – ${clock(end)}`;
}

/** "Starting now", "In 1 minute", "In 4 minutes". */
function whenLabel(msUntilStart) {
  if (!Number.isFinite(msUntilStart) || msUntilStart <= 0) return 'Starting now';
  // Rounded up, because this line is read as time you still have. Rounding 90
  // seconds down to "In 1 minute" promises a minute that is already spent.
  const minutes = Math.ceil(msUntilStart / MINUTE_MS);
  return minutes === 1 ? 'In 1 minute' : `In ${minutes} minutes`;
}

/* ------------------------------------------------------------------- state */

// Which card is showing: 'meeting' or 'detected'. Only a meeting counts down.
let kind = 'meeting';

// Epoch ms the meeting starts, 0 when the payload carried no usable time.
// Anchored to an instant rather than counting a number down, so the line is
// still right after a tick that fired late or a laptop that slept through half
// the countdown.
let startsAt = 0;

// Whether a card has ever been pushed. Kept separate from startsAt because
// the two say different things and want different endings: no push at all
// leaves the sample line in the markup alone, which is what the page shows when
// it is opened in a browser with no preload.
let havePayload = false;

function paintWhen() {
  // A detected card's eyebrow is a fixed label, not a countdown: there is no
  // start time to count to, and the tick must not paint over it.
  if (!havePayload || kind !== 'meeting') return;
  // A meeting that arrived without a usable start empties the line rather than
  // leaving the last one's countdown standing over a new title, which would be
  // a number about a different meeting.
  const text = startsAt ? whenLabel(startsAt - Date.now()) : '';
  if (whenEl.textContent !== text) whenEl.textContent = text;
}

function apply(payload) {
  const meeting = payload && typeof payload === 'object' ? payload : {};

  // A payload with no kind is a calendar meeting. That is the shape main sent
  // before there was a second kind, and it stays the default so an older main
  // and a newer page still agree.
  kind = meeting.kind === 'detected' ? 'detected' : 'meeting';
  card.dataset.kind = kind;

  // A new card replaces whatever the last one had open. The DOM is put back
  // without a report here: the height is reported once below, after the lines
  // have changed, so the number describes the card that is about to show.
  showMenu(false);

  // textContent, never innerHTML, and these are the lines that matter most:
  // the title is calendar text from a remote ICS the user pasted in, and the
  // app name is what main made of a registry key Windows wrote, so both are
  // data from outside the app that this page never gets to trust. innerHTML
  // would hand a crafted event subject a script tag inside a window that has a
  // preload bridge in it.
  if (kind === 'detected') {
    const app = String(meeting.app || '').trim() || 'Unknown app';
    whenEl.textContent = 'Meeting detected';
    titleEl.textContent = app;
    timeEl.textContent = '';
    // The name appears twice, and the second place is inside a label. Still
    // textContent: the span exists so the fixed words can live in the markup
    // and only the name is ever written.
    muteApp.textContent = app;
    startsAt = 0;
  } else {
    titleEl.textContent = String(meeting.title || '').trim() || 'Meeting';

    const start = asDate(meeting.start);
    timeEl.textContent = timeRange(start, asDate(meeting.end));

    // startsInMs is read first: it is main's own number, and main is the side
    // that decided this window should open now, so its countdown and the popup
    // agree even if the event's own start has drifted. `start` is the fallback.
    startsAt = Number.isFinite(meeting.startsInMs)
      ? Date.now() + meeting.startsInMs
      : (start ? start.getTime() : 0);
  }
  havePayload = true;
  paintWhen();

  // Reported for every card, not only after a menu. Main opens the window at
  // the calendar card's height, and a detected card is shorter by the time
  // line it does not have; without this it would sit in a window with a blank
  // strip under the buttons.
  reportHeight();
}

// The popup can sit unanswered for a while if you are still in the meeting
// before this one, so the line re-reads itself rather than staying at whatever
// it said when the window opened. Every second rather than every minute for the
// reason indicator.js runs its own tick at 250 ms: a 60 s timer started 40 s
// into a minute is 40 s late on every boundary it crosses, and "In 1 minute"
// left standing after the meeting began is exactly the staleness this prevents.
// paintWhen only touches the DOM when the string actually changes, so the other
// 59 ticks a minute cost one comparison.
setInterval(paintWhen, 1000);

/* ---------------------------------------------------------------- commands */

function send(command, detail) {
  if (sendCommand) sendCommand(command, detail);
}

take.addEventListener('click', () => send('take'));
dismiss.addEventListener('click', () => send('dismiss'));

/* -------------------------------------------------------------------- menu */

let menuOpen = false;

/**
 * The height the window has to be for the card as it stands right now.
 *
 * Measured, not summed from the stylesheet: main once guessed this window's
 * height and clipped the button. #card has min-height:100%, so once main has
 * grown the window for the open menu, the card's box is the window's height
 * whatever its content needs, and closing the menu would measure the window
 * rather than the card. The floor is dropped for the one read and put back.
 * Anything the page keeps outside the card, a body margin say, is added on;
 * there is none today, so the number is the card's own box, borders included.
 * The rect is viewport-relative, so scrollY is added back to make it a page
 * number: nothing should ever scroll this page, but a card measured 8px short
 * because it had is a clipped menu, not a rounding error. Rounded up, because
 * a fraction of a pixel short is a clipped bottom edge.
 */
function cardHeight() {
  card.style.minHeight = '0';
  const rect = card.getBoundingClientRect();
  card.style.minHeight = '';
  const page = getComputedStyle(document.body);
  const below = (parseFloat(page.paddingBottom) || 0) + (parseFloat(page.marginBottom) || 0);
  return Math.ceil(rect.bottom + scrollY + below);
}

function reportHeight() {
  send('menu', { open: menuOpen, height: cardHeight() });
}

// mousedown rather than click for the outside handler, as home.js does,
// because a click that starts outside and ends inside should still close it.
// The chevron itself is excluded: its mousedown would close the menu and its
// click would open it again, and the button would look stuck open.
function onOutside(e) {
  if (!menu.contains(e.target) && !more.contains(e.target)) toggleMenu(false);
}

/** The DOM side only. Says nothing to main; the callers decide when to. */
function showMenu(open) {
  menuOpen = open;
  menu.hidden = !open;
  more.setAttribute('aria-expanded', String(open));
  if (open) document.addEventListener('mousedown', onOutside, true);
  else document.removeEventListener('mousedown', onOutside, true);
}

/**
 * Open or close the menu and tell main the card's new height, in that order:
 * the menu has to be in the DOM before the height it adds can be measured.
 */
function toggleMenu(open) {
  if (open === menuOpen) return;
  showMenu(open);
  reportHeight();
  // Focus follows the menu the way it does in home.js. In the real popup the
  // keyboard never reaches it, since main makes the window focusable:false,
  // but the page is also used on its own, where it works. preventScroll
  // because focus otherwise scrolls the item into view, and at this moment the
  // window is still the closed card's height: measured, that shifted the whole
  // card up 8px until main caught up with the resize.
  if (open) menu.querySelector('[data-cmd]')?.focus({ preventScroll: true });
}

more.addEventListener('click', () => toggleMenu(!menuOpen));

for (const item of menu.querySelectorAll('[data-cmd]')) {
  item.addEventListener('click', () => {
    // The command first, then the tidy-up. Every one of these ends with main
    // closing this window, and a card that shrank in the instant before it
    // vanished would be a flicker for nothing.
    send(item.dataset.cmd);
    toggleMenu(false);
  });
}

// Escape anywhere on the page, not just on the button. It is dead in the real
// popup: main creates that window focusable:false so it cannot pull focus off a
// call a minute before a meeting, and a window that cannot be focused never
// receives a key. Kept anyway, because it is the way out of this page opened on
// its own for styling work, and because dropping it would leave nothing to
// catch Escape if that window ever becomes focusable. With the menu open it
// closes the menu and stops there, one step back rather than all the way out.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (menuOpen) {
    toggleMenu(false);
    more.focus();
    return;
  }
  send('dismiss');
});

/* ------------------------------------------------------------------- start */

if (onMeeting) {
  // The markup carries a sample meeting so the card can be styled in a plain
  // browser. In the real window that sample is a meeting nobody has, so it goes
  // the moment we know there is a bridge here to push a real one.
  whenEl.textContent = '';
  titleEl.textContent = '';
  timeEl.textContent = '';
  // Called on the bridge object rather than through the captured reference, in
  // case the preload's implementation depends on its own `this`. The unsubscribe
  // it returns is deliberately dropped: main reuses this one window for the next
  // meeting, so the subscription has to outlive any card shown in it.
  bridge.onMeeting(apply);
} else if (location.hash === '#detected') {
  // The same styling-in-a-browser idea for the other kind. The markup can only
  // carry one card at a time, so the detected sample is asked for by name.
  apply({ kind: 'detected', app: 'Chrome', appKey: 'sample' });
}
