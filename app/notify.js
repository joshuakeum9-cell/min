/**
 * The meeting popup's own renderer. Main pushes one meeting in; the only things
 * sent back are 'take' (start a note on it) and 'dismiss' (go away). It holds no
 * calendar state of its own, because the source of truth is the calendar store
 * in main, which is also what decides this window should exist at all.
 *
 * window.notify, the popup window's preload bridge, is read defensively so the
 * page renders the static card in the markup rather than throwing if it is
 * missing, which is also how it looks loaded straight in a browser for styling
 * work.
 */

const bridge = typeof window !== 'undefined' ? window.notify : null;
const onMeeting = bridge && typeof bridge.onMeeting === 'function' ? bridge.onMeeting : null;
const sendCommand = bridge && typeof bridge.send === 'function' ? bridge.send.bind(bridge) : null;

const whenEl = document.getElementById('notifyWhen');
const titleEl = document.getElementById('notifyTitle');
const timeEl = document.getElementById('notifyTime');
const take = document.getElementById('notifyTake');
const dismiss = document.getElementById('notifyDismiss');

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

// Epoch ms the meeting starts, 0 when the payload carried no usable time.
// Anchored to an instant rather than counting a number down, so the line is
// still right after a tick that fired late or a laptop that slept through half
// the countdown.
let startsAt = 0;

// Whether a meeting has ever been pushed. Kept separate from startsAt because
// the two say different things and want different endings: no push at all
// leaves the sample line in the markup alone, which is what the page shows when
// it is opened in a browser with no preload.
let havePayload = false;

function paintWhen() {
  if (!havePayload) return;
  // A meeting that arrived without a usable start empties the line rather than
  // leaving the last one's countdown standing over a new title, which would be
  // a number about a different meeting.
  const text = startsAt ? whenLabel(startsAt - Date.now()) : '';
  if (whenEl.textContent !== text) whenEl.textContent = text;
}

function apply(payload) {
  const meeting = payload && typeof payload === 'object' ? payload : {};

  // textContent, never innerHTML, and this is the line that matters most:
  // the title is calendar text from a remote ICS the user pasted in, so it is
  // data from outside the app that this page never gets to trust. innerHTML
  // would hand a crafted event subject a script tag inside a window that has a
  // preload bridge in it.
  titleEl.textContent = String(meeting.title || '').trim() || 'Meeting';

  const start = asDate(meeting.start);
  timeEl.textContent = timeRange(start, asDate(meeting.end));

  // startsInMs is read first: it is main's own number, and main is the side
  // that decided this window should open now, so its countdown and the popup
  // agree even if the event's own start has drifted. `start` is the fallback.
  startsAt = Number.isFinite(meeting.startsInMs)
    ? Date.now() + meeting.startsInMs
    : (start ? start.getTime() : 0);
  havePayload = true;
  paintWhen();
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

function send(command) {
  if (sendCommand) sendCommand(command);
}

take.addEventListener('click', () => send('take'));
dismiss.addEventListener('click', () => send('dismiss'));

// Escape anywhere on the page, not just on the button. This window puts itself
// in front of whatever you were doing a minute before a meeting, so the way out
// of it should be the key you already reach for to close things.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
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
}
