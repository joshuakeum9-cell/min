/**
 * The floating recording indicator's own renderer. Main pushes state in; the
 * only things sent back are 'focus' (go back to the note) and 'stop'. It holds
 * no recording state of its own, because the source of truth is the note view
 * that owns the microphone.
 *
 * window.indicator, the floating window's preload bridge, is read defensively
 * so the page renders a static idle pill rather than throwing if it is missing,
 * which is also how it looks loaded straight in a browser for styling work.
 */

const bridge = typeof window !== 'undefined' ? window.indicator : null;
const onState = bridge && typeof bridge.onState === 'function' ? bridge.onState : null;
const sendCommand = bridge && typeof bridge.send === 'function' ? bridge.send.bind(bridge) : null;

const face = document.getElementById('face');
const clock = document.getElementById('clock');
const stop = document.getElementById('stop');
const bars = [...document.querySelectorAll('.wave i')];

// How much of each bar comes from "them" rather than "you": leftmost is purely
// system audio, rightmost purely the microphone. Same left/right split as the
// transcript bubbles, so the pill says who is talking without any labels.
const MIX = [1, 0.65, 0.35, 0];

let recording = false;  // capturing audio: bars green and dancing
let you = 0, them = 0;  // 0..1 levels from the last push
let seconds = 0;        // what the clock shows
let localOrigin = 0;    // epoch ms we count from when main sends no duration

function clamp(n) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

const two = (n) => String(n).padStart(2, '0');

function formatClock(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

// Main may or may not say how long the meeting has run. Prefer whatever it
// sends; null means nothing was sent and we have to count for ourselves, so
// the clock is never stuck at 00:00.
function elapsedFrom(state) {
  if (Number.isFinite(state.elapsed)) return state.elapsed;
  if (Number.isFinite(state.seconds)) return state.seconds;
  if (Number.isFinite(state.startedAt)) return (Date.now() - state.startedAt) / 1000;
  return null;
}

function paint() {
  for (let i = 0; i < bars.length; i++) {
    const w = MIX[i % MIX.length];
    const level = recording ? them * w + you * (1 - w) : 0;
    // A little per-bar jitter is what reads as "dancing" rather than a meter.
    const jitter = level > 0.02 ? 0.8 + Math.random() * 0.4 : 1;
    bars[i].style.setProperty('--lvl', Math.min(1, level * jitter).toFixed(3));
  }
  clock.textContent = formatClock(seconds);
  document.body.classList.toggle('rec', recording);
}

function apply(payload) {
  const state = payload && typeof payload === 'object' ? payload : {};
  recording = Boolean(state.recording);
  you = clamp(state.you);
  them = clamp(state.them);

  const given = elapsedFrom(state);
  if (given !== null) {
    seconds = given;
    localOrigin = 0;
  } else if (!recording) {
    seconds = 0;
    localOrigin = 0;
  } else {
    // Anchor to a start time rather than adding 1 each tick, so the clock does
    // not drift when the interval fires late.
    if (!localOrigin) localOrigin = Date.now() - seconds * 1000;
    seconds = (Date.now() - localOrigin) / 1000;
  }

  // State arrives many times a second, so only touch the DOM on a real change.
  const tip = state.title ? `Back to ${state.title}` : 'Back to the note';
  if (face.title !== tip) face.title = tip;
  paint();
}

// Levels arrive many times a second, but a state push is not guaranteed while
// the room is silent, so the clock gets its own tick.
setInterval(() => {
  if (localOrigin && recording) seconds = (Date.now() - localOrigin) / 1000;
  paint();
}, 500);

/* ------------------------------------------------------------------- drag */

/*
 * Dragging by hand, because -webkit-app-region:drag does nothing here.
 *
 * Measured on Windows: on a focusable:false window the drag region is inert, but
 * the page still receives mousedown and mousemove carrying real screenX/screenY.
 * So the grab offset is taken on mousedown and every move re-places the window
 * at (screen - offset). focusable stays false, which is the property that keeps
 * a click on this pill from pulling focus off the call behind it.
 *
 * A drag past DRAG_SLOP suppresses the click that follows, so parking the pill
 * never also jumps you back to the note.
 */
const DRAG_SLOP = 4;
const moveTo = bridge && typeof bridge.moveTo === 'function' ? bridge.moveTo.bind(bridge) : null;

let grab = null;      // { dx, dy } from the window's top left to the pointer
let dragged = false;  // moved past the slop, so the click is not a click

document.body.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !moveTo) return;
  // window.screenX/Y is this window's own top left, so the offset is exact
  // whatever the display scaling.
  grab = { dx: e.screenX - window.screenX, dy: e.screenY - window.screenY };
  dragged = false;
});

addEventListener('mousemove', (e) => {
  if (!grab) return;
  const x = e.screenX - grab.dx;
  const y = e.screenY - grab.dy;
  if (!dragged && Math.abs(x - window.screenX) + Math.abs(y - window.screenY) < DRAG_SLOP) return;
  dragged = true;
  moveTo(x, y);
});

addEventListener('mouseup', () => { grab = null; });

face.addEventListener('click', () => {
  if (dragged || !sendCommand) return;
  sendCommand('focus');
});
stop.addEventListener('click', (e) => {
  e.stopPropagation(); // never read as a click on the pill body
  if (dragged || !sendCommand) return;
  sendCommand('stop');
});
// Anywhere that is not the stop button also means "take me back to the note".
document.body.addEventListener('click', (e) => {
  if (dragged) return;
  if (e.target.closest('#stop') || e.target.closest('#face')) return;
  if (sendCommand) sendCommand('focus');
});

// Called on the bridge object rather than through the captured reference, in
// case the preload's implementation depends on its own `this`.
if (onState) bridge.onState(apply);
paint();
