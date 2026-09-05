/**
 * The note view: one document that is also the recorder.
 *
 * Owns capture (moved here from renderer.js, behaviour unchanged), the live
 * transcript push, the save on stop, the transcript panel and the write-up
 * hand-off. renderer.js is a router now and calls initNote() once, then
 * newNote() or openMeeting() whenever the view is shown.
 *
 * Two safety properties from the old renderer are load-bearing and kept as they
 * were: every failure after a device is live goes through fail(), which tears
 * the capture down and re-enables Record; and a failed save hands the PCM back
 * to the buffers so a full disk does not lose hours of meeting.
 *
 * The WAV pair stays the authoritative recording. The live path is a second
 * consumer of the same Float32 blocks, converted to Int16 and pushed over IPC in
 * quarter-second frames; if it fails, the recording is untouched and the
 * post-stop transcribe path still exists.
 */
import { renderMarkdown } from './md.js';
import { renderBubbles, appendBubble, segmentsFromTranscript } from './conversation.js';

const $ = (id) => document.getElementById(id);

let api = null;
let onStatusCb = null;

const setStatus = (m, cls = '') => {
  const el = $('status');
  if (el) { el.className = cls; el.textContent = m; }
  onStatusCb?.(m, cls);
};

/* ============================================================== recording */

const SAMPLE_RATE = 16000;   // what the recogniser wants; the browser resamples
const MAX_MINUTES = 180;

// Level bars redraw at most this often. The worklet ticks every 8 ms and
// painting on every tick is CPU spent on decoration during a call.
const LEVEL_FPS = 15;

// The floating indicator lives in its own window and cannot read this DOM, so
// it is fed by message instead. Twelve a second is enough for bars that read as
// moving, and an order of magnitude less traffic than the worklet's own rate.
const STATE_FPS = 12;

// How long the pill waits for a level before falling back to a canned
// animation. Four frozen bars during a live recording is the one thing the
// indicator must never show, so a stalled worklet still looks alive.
const LEVEL_STALE_MS = 500;

// One live frame per track: a quarter second at 16 kHz. Frames this size keep
// the IPC channel to a few messages a second while staying well under the
// latency anyone would notice in a scrolling transcript.
const LIVE_FRAME_SAMPLES = SAMPLE_RATE / 4;

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.blocks = 0; this.empty = 0; this.frames = 0; }
  process(inputs) {
    this.blocks++;
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) { this.empty++; return true; }
    this.frames += ch.length;
    let peak = 0, sum = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
      sum += ch[i] * ch[i];
    }
    this.port.postMessage({ pcm: ch.slice(0), peak, rms: Math.sqrt(sum / ch.length), frames: this.frames, blocks: this.blocks, empty: this.empty });
    return true;
  }
}
registerProcessor('tap', Tap);
`;

// Capture keys stay mic/sys because meeting.json and the WAV names use them.
// The live worker and the bubbles speak you/them; LIVE_TRACK is the bridge.
const LIVE_TRACK = { mic: 'you', sys: 'them' };

const T = {
  mic: { chunks: [], frames: 0, empty: 0, blocks: 0, peak: 0, level: 0 },
  sys: { chunks: [], frames: 0, empty: 0, blocks: 0, peak: 0, level: 0 },
};

let ctx = null, streams = {}, nodes = [], recording = false;
let startedAt = 0, tick = null, deviceEvents = [], capTimer = null;
let starting = false;   // start() awaits several times before disabling the button
let levelTimer = null, stateTimer = null;
let lastLevelAt = 0;    // when the worklet last handed us a block, for the pill

// Live transcript state for the recording in progress.
let live = { active: false, frames: null };
let calendarEvent = null;   // what auto-titled this note, saved into meeting.json

// The meeting this view is showing once one exists on disk: a saved recording
// or one opened from the home list.
let current = null;
let currentSegments = [];

/** Release every device and node. Safe to call twice. */
function teardownCapture() {
  clearInterval(tick); clearTimeout(capTimer);
  clearInterval(levelTimer); clearInterval(stateTimer);
  levelTimer = null; stateTimer = null;
  for (const n of nodes) { try { n.disconnect(); } catch {} }
  nodes = [];
  for (const st of Object.values(streams)) st?.getTracks().forEach((t) => t.stop());
  streams = {};
  paintLevels(true);
}

function resetTracks() {
  for (const k of ['mic', 'sys']) {
    Object.assign(T[k], { chunks: [], frames: 0, empty: 0, blocks: 0, peak: 0, level: 0 });
  }
  deviceEvents = [];
}

/* ------------------------------------------------------------ level bars */

// Each cluster is a handful of bars that share one level but move a little
// apart from each other, which is what reads as "dancing" rather than a meter.
const BAR_SHAPE = [0.55, 0.85, 1, 0.85, 0.55];
const bars = { them: [], you: [] };

function initLevelBars() {
  const root = $('levelBars');
  if (!root) return;
  // The shell owner supplies the markup; if it has not, build the minimum so
  // the view still works. Left cluster is them, right cluster is you.
  if (!root.querySelector('.bar')) {
    for (const track of ['them', 'you']) {
      const cluster = document.createElement('span');
      cluster.className = `cluster ${track}`;
      cluster.dataset.track = track;
      for (let i = 0; i < BAR_SHAPE.length; i++) {
        const b = document.createElement('i');
        b.className = 'bar';
        cluster.appendChild(b);
      }
      root.appendChild(cluster);
    }
  }
  for (const track of ['them', 'you']) {
    bars[track] = [...root.querySelectorAll(`.${track} .bar, [data-track="${track}"] .bar`)];
  }
}

function paintLevels(silent = false) {
  for (const [key, track] of Object.entries(LIVE_TRACK)) {
    const lvl = silent ? 0 : T[key].level;
    const list = bars[track];
    for (let i = 0; i < list.length; i++) {
      const shape = BAR_SHAPE[i % BAR_SHAPE.length];
      const jitter = lvl > 0.02 ? 0.8 + Math.random() * 0.4 : 1;
      list[i].style.setProperty('--lvl', Math.min(1, lvl * shape * jitter).toFixed(3));
    }
  }
  paintPill(silent);
}

/* -------------------------------------------------------------- mic pill */

/*
 * The circular control at the left of the note bar. It is two things at once,
 * which is how Granola's is built: the bars are the recording tell, and
 * clicking them opens the transcript they have been filling.
 */
const pillBars = [];

function initMicPill() {
  const pill = $('micPill');
  if (!pill) return;
  pillBars.length = 0;
  pillBars.push(...pill.querySelectorAll('.waveform i'));
  syncPill();
}

/**
 * The caret and aria-pressed follow the panel's visibility rather than a flag
 * of their own. Several paths open that panel (a live session starting, a
 * saved transcript loading, the pill itself) and all of them must agree.
 */
function syncPill() {
  const pill = $('micPill');
  const panel = $('transcriptPanel');
  if (!pill || !panel) return;
  const shown = !panel.classList.contains('hide');
  pill.setAttribute('aria-pressed', String(shown));
  pill.title = shown ? 'Hide the transcript' : 'Show the transcript';
}

/**
 * One control, two tracks: the pill follows whichever side is louder, so it
 * moves whether you are talking or they are. Only the level and a little
 * jitter come from here; the per-bar shape is --k in the stylesheet, or the
 * four bars would rise and fall as one block.
 */
function paintPill(silent = false) {
  const pill = $('micPill');
  if (!pill) return;
  const lvl = silent ? 0 : Math.max(T.mic.level, T.sys.level);
  for (const bar of pillBars) {
    const jitter = lvl > 0.02 ? 0.75 + Math.random() * 0.5 : 1;
    bar.style.setProperty('--lvl', Math.min(1, lvl * jitter).toFixed(3));
  }
  // Real levels always win. The keyframe covers a stalled worklet, nothing else.
  pill.classList.toggle('hum', recording && Date.now() - lastLevelAt > LEVEL_STALE_MS);
}

/**
 * Tell the floating indicator what this window is doing. Fire and forget, and
 * every part of it optional: the bridge method may not exist and the channel
 * may be dead, and neither is allowed to reach the recording.
 */
function pushRecordingState() {
  try {
    api?.recordingState?.({
      recording,
      you: T.mic.level, them: T.sys.level,
      title: $('noteTitle')?.value.trim() ?? '',
    });
  } catch { /* the recording does not depend on the indicator */ }
}

/* ------------------------------------------------------------- live push */

function newLiveFrames() {
  return {
    mic: { buf: new Int16Array(LIVE_FRAME_SAMPLES), n: 0 },
    sys: { buf: new Int16Array(LIVE_FRAME_SAMPLES), n: 0 },
  };
}

/**
 * Convert one worklet block to Int16 and push it once a frame is full. Clamped
 * first: system audio has been measured over full scale, and an unclamped
 * multiply wraps a loud sample to the opposite sign.
 */
function livePushBlock(key, pcm) {
  const f = live.frames?.[key];
  if (!f) return;
  let i = 0;
  while (i < pcm.length) {
    const room = LIVE_FRAME_SAMPLES - f.n;
    const take = Math.min(room, pcm.length - i);
    for (let k = 0; k < take; k++, i++) {
      const s = pcm[i] < -1 ? -1 : pcm[i] > 1 ? 1 : pcm[i];
      f.buf[f.n + k] = Math.round(s * 32767);
    }
    f.n += take;
    if (f.n === LIVE_FRAME_SAMPLES) {
      sendLive(key, f.buf.buffer);
      f.buf = new Int16Array(LIVE_FRAME_SAMPLES);
      f.n = 0;
    }
  }
}

function liveFlush() {
  for (const key of ['mic', 'sys']) {
    const f = live.frames?.[key];
    if (f && f.n > 0) sendLive(key, f.buf.slice(0, f.n).buffer);
    if (f) f.n = 0;
  }
}

function sendLive(key, arrayBuffer) {
  if (!live.active) return;
  try {
    api.livePush(LIVE_TRACK[key], arrayBuffer);
  } catch (e) {
    // A dead channel must never take the recording with it. Stop pushing; the
    // WAV path still produces a transcript after the fact.
    live.active = false;
    setStatus('Live transcript stopped (' + e.message + '). The recording continues.', 'warn');
  }
}

/* --------------------------------------------------------------- capture */

async function attach(key, stream) {
  const src = ctx.createMediaStreamSource(stream);
  // A bare node inherits channelCount:2/'max', so a stereo loopback source
  // presents two channels and the worklet's inputs[0][0] silently drops the
  // right one. Forcing explicit mono makes the graph do the spec's 0.5*(L+R).
  const node = new AudioWorkletNode(ctx, 'tap', {
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  node.port.onmessage = ({ data }) => {
    const t = T[key];
    t.chunks.push(data.pcm);
    t.frames = data.frames; t.blocks = data.blocks; t.empty = data.empty;
    if (data.peak > t.peak) t.peak = data.peak;
    // Same curve the old meter used, so quiet speech still visibly moves.
    t.level = Math.min(1, Math.sqrt(data.peak) * 1.3);
    // Proof that audio is still flowing, which is what keeps the pill off its
    // fallback animation. Silence counts: a silent block is still a block.
    lastLevelAt = Date.now();
    if (live.active) livePushBlock(key, data.pcm);
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;               // pull the graph without reaching the speakers
  src.connect(node).connect(mute).connect(ctx.destination);
  nodes.push(src, node, mute);
}

/**
 * Two failures look alike but mean opposite things. A silent-but-flowing track is
 * a dead device. A track with no frames at all is ambiguous on Windows, because
 * WASAPI loopback sends nothing during silence rather than sending zeros, so an
 * idle machine and a broken capture are indistinguishable from here. Say which is
 * which instead of guessing, and keep watching rather than crying wolf.
 */
function checkSignal() {
  const problems = [];
  for (const [key, label] of [['mic', 'your microphone'], ['sys', 'system audio']]) {
    const t = T[key];
    if (t.peak >= 1e-4) continue;
    problems.push(
      t.frames === 0
        ? `${label} has delivered no data yet` +
            (key === 'sys' ? ' (normal if nothing is playing)' : '')
        : `${label} is delivering audio but it is silent: wrong device, or muted`
    );
  }
  if (!problems.length) return setStatus('Recording. Both channels have signal.');
  setStatus(problems.join('. ') + '.', 'warn');
  if (recording) capTimer = setTimeout(checkSignal, 2000);
}

function onDeviceChange() {
  deviceEvents.push({ at: Date.now() - startedAt, event: 'devicechange' });
  setStatus('Audio devices changed mid-recording. A gap may exist from here.', 'warn');
}

/** Ask the calendar what is on right now. Never throws, never blocks. */
async function autoTitle() {
  const title = $('noteTitle');
  if (!title || title.value.trim()) return;
  try {
    const ev = await api.calendarEventNow?.();
    if (!ev || !ev.title) return;
    // Only fill a title the user has not typed in the meantime.
    if (title.value.trim()) return;
    title.value = ev.title;
    calendarEvent = ev;
    renderMeta({ startedAt: ev.start, endedAt: ev.end, calendarEvent: ev, autoTitled: true });
  } catch { /* the calendar is a convenience; the recording is the job */ }
}

async function start() {
  // Several awaits happen before the button is disabled. Without this guard a
  // second click attaches a second pair of worklet nodes to the same buffers;
  // the frame counters then disagree with the data and concat() throws on Stop,
  // outside the try, losing the meeting and wedging the button.
  if (recording || starting) return;
  if (current) {
    // The view holds a saved meeting. A new recording is a new note.
    newNote();
  }
  starting = true;
  const rec = $('recBtn');
  rec.disabled = true;

  teardownCapture();
  resetTracks();
  currentSegments = [];
  $('writeRow')?.classList.add('hide');
  $('bubbles')?.replaceChildren();
  setStatus('Requesting microphone...');

  try {
    streams.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) { return fail('Microphone unavailable: ' + e.message); }

  setStatus('Requesting system audio...');
  // restrictOwnAudio keeps our own output out of the "them" track; an unknown
  // constraint is fatal, so fall back rather than fail the whole recording.
  for (const audio of [{ restrictOwnAudio: true }, true]) {
    try {
      streams.sys = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 4, height: 4, frameRate: 1 }, audio,
      });
      break;
    } catch (e) { /* try the next shape */ }
  }
  if (!streams.sys) return fail('System audio was denied. Nothing recorded.');
  streams.sys.getVideoTracks().forEach((t) => t.stop());
  if (streams.sys.getAudioTracks().length === 0)
    return fail('No system-audio track: loopback is unsupported here.');

  // Both devices are already live at this point. An exception escaping this
  // region would leave the microphone and the loopback capturing with the UI
  // showing idle and Record stuck disabled, so route it through fail(), which
  // tears the capture down, clears starting and re-enables the button.
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    await attach('mic', streams.mic);
    await attach('sys', streams.sys);
  } catch (e) {
    try { await ctx?.close(); } catch { /* never opened, or already closed */ }
    ctx = null;
    return fail('Audio pipeline could not start: ' + e.message);
  }

  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  for (const s of [streams.mic, streams.sys]) {
    s.getAudioTracks().forEach((tr) =>
      tr.addEventListener('ended', () => {
        deviceEvents.push({ at: Date.now() - startedAt, event: 'track-ended', label: tr.label });
        setStatus(`"${tr.label || 'a device'}" stopped mid-recording. Audio from here is lost.`, 'warn');
      }));
  }

  startedAt = Date.now();
  recording = true;
  starting = false;
  // The first block is milliseconds away; dating the level now buys the pill
  // one stale window of grace so it does not flash its fallback on every start.
  lastLevelAt = Date.now();
  rec.disabled = false;
  rec.classList.add('rec-on');
  setRecLabel('Stop');
  $('clock')?.classList.add('live');
  $('micPill')?.classList.add('live');
  $('transcriptPanel')?.classList.add('recording');
  setStatus('Recording...');
  pushRecordingState();

  // Everything from here is decoration or a bonus. Nothing in it may throw
  // into the recording, so each piece is fenced on its own.
  autoTitle();
  applyOnTop(true);
  startLive();

  levelTimer = setInterval(() => paintLevels(), Math.round(1000 / LEVEL_FPS));
  stateTimer = setInterval(pushRecordingState, Math.round(1000 / STATE_FPS));

  tick = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const clock = $('clock');
    if (clock) clock.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    // A driver that fails in place fires no event and keeps feeding zeros, so the
    // latched peak still reads healthy. `muted` is what actually catches it.
    for (const st of Object.values(streams)) {
      for (const tr of st?.getAudioTracks() ?? []) {
        if (tr.muted || tr.readyState === 'ended') {
          deviceEvents.push({ at: Date.now() - startedAt, event: 'track-muted', label: tr.label });
          setStatus(`"${tr.label || 'a device'}" went silent mid-recording.`, 'warn');
        }
      }
    }
    if (s > MAX_MINUTES * 60) stopRec();
  }, 250);

  capTimer = setTimeout(checkSignal, 4000);
}

/** Begin the live session if the setting is on. Failure here is not a failure of the recording. */
async function startLive() {
  live = { active: false, frames: null };
  try {
    const settings = (await api.settingsGet?.()) ?? {};
    if (!settings.liveTranscript || typeof api.liveStart !== 'function') return;
    if (!recording) return; // stopped during the await
    const r = await api.liveStart({ title: $('noteTitle')?.value.trim() ?? '' });
    if (!recording) return;
    if (!r?.ok) {
      setStatus('Live transcript unavailable (' + (r?.error ?? 'unknown') + '). Recording continues; transcribe after.', 'warn');
      return;
    }
    live = { active: true, frames: newLiveFrames() };
    $('transcriptPanel')?.classList.remove('hide');
    syncPill();
    renderBubbles($('bubbles'), [], { live: true });
  } catch (e) {
    setStatus('Live transcript unavailable (' + e.message + '). Recording continues; transcribe after.', 'warn');
  }
}

/** The window rides above the call only while recording, and only if asked. */
async function applyOnTop(on) {
  try {
    if (typeof api.setAlwaysOnTop !== 'function') return;
    if (on) {
      const settings = (await api.settingsGet?.()) ?? {};
      if (!settings.alwaysOnTop || !recording) return;
    }
    await api.setAlwaysOnTop(on);
  } catch { /* cosmetic */ }
}

function fail(msg) {
  teardownCapture();
  starting = false;
  const rec = $('recBtn');
  rec.disabled = false;
  rec.classList.remove('rec-on');
  setRecLabel('Record');
  $('micPill')?.classList.remove('live', 'hum');
  $('transcriptPanel')?.classList.remove('recording');
  setStatus(msg, 'warn');
  pushRecordingState();
}

// Derive the length from the data itself. Trusting a separately-maintained
// counter is what turns any counter drift into an out-of-bounds write.
const concat = (chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

async function stopRec() {
  if (!recording) return;
  recording = false;
  clearInterval(tick); clearTimeout(capTimer);
  navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  const rec = $('recBtn');
  rec.disabled = true;
  $('clock')?.classList.remove('live');
  $('micPill')?.classList.remove('live', 'hum');
  $('transcriptPanel')?.classList.remove('recording');
  // Before the save, which can take a moment: the floating window should go
  // grey the instant the user presses Stop, not when the disk is done.
  pushRecordingState();
  setStatus('Saving...');

  const endedAt = Date.now();
  const sr = ctx.sampleRate;
  const wasLive = live.active;
  if (wasLive) liveFlush();
  teardownCapture();
  try { await ctx.close(); } catch {}
  applyOnTop(false);

  // Held outside the try so a failed save can hand the PCM back. The chunk
  // arrays are still released before the save, so the success path never holds
  // two copies of a three-hour recording at once.
  let mic = null, sys = null;
  let saved = null;
  try {
    mic = concat(T.mic.chunks);
    sys = concat(T.sys.chunks);
    T.mic.chunks = []; T.sys.chunks = [];
    const { dir, meta } = await api.saveMeeting({
      startedAt, endedAt,
      title: $('noteTitle')?.value.trim() ?? '',
      notes: $('notes')?.value ?? '',
      sampleRate: sr,
      mic: new Uint8Array(mic.buffer),
      system: new Uint8Array(sys.buffer),
      timeline: {
        deviceEvents,
        mic: { renderBlocks: T.mic.blocks, emptyBlocks: T.mic.empty },
        system: { renderBlocks: T.sys.blocks, emptyBlocks: T.sys.empty },
      },
      calendarEvent,
    });
    saved = { dir, meta };
    current = {
      dir, title: meta.title, startedAt: meta.startedAt, endedAt: meta.endedAt,
      durationSeconds: meta.durationSeconds, transcribed: false, written: false, meta,
    };
    $('writeRow')?.classList.remove('hide');
    renderMeta({ ...meta, calendarEvent, autoTitled: Boolean(calendarEvent) });

    const bad = Object.entries(meta.tracks).filter(([, t]) => t.silent).map(([k]) => k);
    if (bad.length) setStatus(`Saved, but ${bad.join(' and ')} captured silence.`, 'warn');
    else if (deviceEvents.length) setStatus(
      `Saved ${meta.durationSeconds.toFixed(0)}s, but an audio device changed or ` +
      `stopped during the recording. Check the transcript for gaps.`, 'warn');
    else setStatus(
      `Saved ${meta.durationSeconds.toFixed(0)}s. You ${meta.tracks.mic.voicedSeconds}s, ` +
      `them ${meta.tracks.system.voicedSeconds}s.`, 'good');
  } catch (e) {
    // The file on disk was the only copy this path was about to make, so put
    // the audio back rather than discarding hours of meeting on a full disk.
    if (mic) T.mic.chunks = [mic];
    if (sys) T.sys.chunks = [sys];
    setStatus(
      'Save failed: ' + e.message +
      ' The recording is still in memory. Keep this window open: it is lost if you ' +
      'close the app or start another recording.', 'warn');
  } finally {
    // Must run even when concat or saveMeeting throws, or Record stays dead.
    rec.disabled = false;
    rec.classList.remove('rec-on');
    setRecLabel('Record');
    const clock = $('clock');
    if (clock) clock.textContent = '00:00';
  }

  // The live session is finished after the save so the WAV is on disk before
  // anything waits on the worker's last lines. Its result is a transcript.md
  // written by main; the segments it returns are only the fallback picture.
  if (wasLive) await finishLive(saved);
}

async function finishLive(saved) {
  live.active = false;
  let result = null;
  try {
    setStatus('Finishing the live transcript...');
    // The folder the save above produced. Without it main has nowhere to put
    // transcript.md, which is how every live transcript used to be discarded.
    result = await api.liveStop(saved?.dir);
  } catch (e) {
    setStatus('Live transcript did not finish (' + e.message + '). Use Write up to transcribe from the audio.', 'warn');
    return;
  }
  if (!saved) return; // nothing on disk to attach it to; the status already says so
  const fresh = await reloadCurrent();
  if (fresh?.transcript && result?.complete === false) {
    // Written, but the worker restarted part-way, so the audio it missed is not
    // in these lines. The wavs are kept for exactly this case, and Write up can
    // still make a complete transcript from them.
    setStatus(
      `Saved with a live transcript of ${result.count} lines, but the transcriber ` +
      'restarted during the meeting, so it may have a gap. The audio was kept: ' +
      'use Write up to transcribe it again.', 'warn');
  } else if (fresh?.transcript) {
    const n = result?.count ?? currentSegments.length;
    setStatus(`Saved with a live transcript of ${n} lines.`, 'good');
  } else if (result?.segments?.length) {
    currentSegments = result.segments.filter((s) => !s.echo);
    renderBubbles($('bubbles'), currentSegments, { live: false });
    setStatus('Saved. The live transcript was not written to disk; Write up will transcribe from the audio.', 'warn');
  } else {
    setStatus('Saved. Nothing was recognised live; Write up will transcribe from the audio.', 'warn');
  }
}

/* ============================================================ note view */

function setRecLabel(text) {
  const rec = $('recBtn');
  if (!rec) return;
  let label = rec.querySelector('.label');
  if (!label) {
    // Wrap the button's own text so the clock and glyphs beside it survive
    // the toggle. Done once, on whatever markup the shell shipped.
    label = document.createElement('span');
    label.className = 'label';
    const texts = [...rec.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
    for (const n of texts) n.remove();
    rec.prepend(label);
  }
  label.textContent = text;
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const fmtDuration = (seconds) => {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};

/** Attendee names from whatever shape the calendar event carries. */
function attendeeNames(ev) {
  const list = Array.isArray(ev?.attendees) ? ev.attendees : [];
  return list
    .map((a) => (typeof a === 'string' ? a : a?.name || a?.email || ''))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

/**
 * The chips under the title. `info` is a meeting.json-like object: startedAt,
 * endedAt, durationSeconds, calendarEvent, autoTitled.
 */
function renderMeta(info) {
  const meta = $('noteMeta');
  if (!meta) return;
  meta.replaceChildren();
  const chip = (text, cls = '') => {
    if (!text) return;
    const el = document.createElement('span');
    el.className = `chip ${cls}`.trim();
    el.textContent = text;
    meta.appendChild(el);
  };

  const ev = info?.calendarEvent ?? null;
  const start = info?.startedAt ?? ev?.start;
  const end = info?.endedAt ?? ev?.end;
  if (start && end) chip(`${fmtTime(start)} to ${fmtTime(end)}`, 'time');
  else if (start) chip(fmtTime(start), 'time');

  const dur = info?.durationSeconds ??
    (ev?.start && ev?.end ? (new Date(ev.end) - new Date(ev.start)) / 1000 : null);
  if (dur) chip(fmtDuration(dur), 'duration');

  const names = attendeeNames(ev);
  const count = names.length || Number(ev?.attendeeCount) || 0;
  if (count) chip(`${count} attendee${count === 1 ? '' : 's'}`, 'attendees');
  if (ev?.recurring) chip('Recurring', 'recurring');
  if (info?.autoTitled) chip('Auto-titled from calendar', 'auto');
}

/** Re-read the current meeting from disk and redraw the transcript panel. */
async function reloadCurrent() {
  if (!current?.dir) return null;
  try {
    const m = await api.readMeeting(current.dir);
    if (!m) return null;
    current = m;
    showTranscript(m);
    showWriteUp(m);
    return m;
  } catch {
    return null;
  }
}

function showTranscript(m) {
  const panel = $('transcriptPanel');
  const box = $('bubbles');
  if (m?.transcript) {
    currentSegments = segmentsFromTranscript(m.transcript);
    renderBubbles(box, currentSegments, { live: false });
    panel?.classList.remove('hide');
  } else if (!recording) {
    currentSegments = [];
    box?.replaceChildren();
  }
  // Whatever the branch decided, the pill's caret has to match it.
  syncPill();
}

/**
 * The saved write-up, if any. Rendered through md.js, which escapes before it
 * parses, so pasted model output cannot reach the DOM as markup.
 */
function showWriteUp(m) {
  const box = $('writeUp');
  if (!box) return;
  if (m?.note) {
    box.innerHTML = renderMarkdown(m.note);
    box.classList.remove('hide');
  } else {
    box.replaceChildren();
    box.classList.add('hide');
  }
  $('pasteRow')?.classList.toggle('hide', !m?.transcribed);
}

/** The transcript as text for the clipboard, in the file's own line format. */
function transcriptText() {
  const p = (n) => String(n).padStart(2, '0');
  return currentSegments.map((s) => {
    const t = Math.max(0, Math.floor(s.t0));
    const stamp = `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
    return `[${stamp}] ${s.track === 'you' ? 'You' : 'Them'}: ${s.text}`;
  }).join('\n');
}

/* ----------------------------------------------------------- write-up row */

/**
 * The assistants a user might already pay for.
 *
 * The app never sees a login. It puts the prompt on the clipboard and opens the
 * provider's site in the normal browser, where the user is already signed in.
 * That is the whole integration: no keys, no OAuth, nothing to revoke, and it
 * works identically for every provider.
 */
const PROVIDERS = [
  { id: 'claude',     name: 'Claude' },
  { id: 'chatgpt',    name: 'ChatGPT' },
  { id: 'gemini',     name: 'Gemini' },
  { id: 'copilot',    name: 'Copilot' },
  { id: 'perplexity', name: 'Perplexity' },
  { id: 'grok',       name: 'Grok' },
  { id: 'mistral',    name: 'Le Chat' },
  { id: 'deepseek',   name: 'DeepSeek' },
  { id: '',           name: 'Clipboard only' },
];

async function initProviders() {
  const sel = $('provider');
  if (!sel) return;
  sel.replaceChildren();
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  // The preference lives in settings now; the router migrates the old
  // localStorage key there, so this only needs to read one place.
  let saved = null;
  try { saved = (await api.settingsGet?.())?.provider ?? null; } catch {}
  if (saved === null) { try { saved = localStorage.getItem('provider'); } catch {} }
  sel.value = saved ?? 'claude';
  if (!PROVIDERS.some((p) => p.id === sel.value)) sel.value = 'claude';
  sel.addEventListener('change', () => {
    try { api.settingsSet?.({ provider: sel.value }); } catch {}
    try { localStorage.setItem('provider', sel.value); } catch {}
  });
}

/** Transcribe then put the write-up prompt on the clipboard. */
async function writeUp(btn) {
  const dir = current?.dir;
  if (!dir) return setStatus('Record or open a meeting first.', 'warn');
  btn.disabled = true;
  try {
    const meeting = await api.readMeeting(dir);
    if (!meeting?.transcribed) {
      // On a fresh install this call also downloads ~640 MB. Promising a fast
      // transcription while silently fetching that is a lie. The range is the
      // measured one: 4.5 to 6 min per hour on a 6-core desktop, 7 to 9 on the
      // 4-core laptop this targets. Quote the span, never the best case.
      const ready = await api.modelsReady();
      setStatus(
        ready
          ? 'Transcribing on this machine, roughly 5 to 9 min per hour of audio...'
          : 'First run: downloading the ~640 MB speech model. This happens once.'
      );
      const t = await api.transcribe(dir);
      if (t.empty) {
        setStatus(
          'Nothing was recognised in this recording. The audio has been kept so you can try '
            + 'again: check the microphone and system-audio devices, then press Write up.',
          'warn'
        );
        return;
      }
      const echo = t.echoes ? ` (${t.echoes} echo line${t.echoes > 1 ? 's' : ''} removed)` : '';
      setStatus(`Transcribed ${t.count} utterances${echo}. Copying...`);
      await reloadCurrent();
    }
    const p = await api.copyPrompt(dir);
    const providerId = $('provider')?.value ?? '';
    const providerName = PROVIDERS.find((x) => x.id === providerId)?.name ?? '';

    if (providerId) {
      await api.openProvider(providerId);
      setStatus(
        `~${p.words.toLocaleString()} words copied. ${providerName} is opening: press Ctrl+V, ` +
          `then paste the answer back into this note.`,
        'good'
      );
    } else {
      setStatus(`Copied ~${p.words.toLocaleString()} words to the clipboard.`, 'good');
    }
    $('pasteRow')?.classList.remove('hide');
  } catch (e) {
    setStatus('Failed: ' + e.message, 'warn');
  } finally { btn.disabled = false; }
}

/* --------------------------------------------------------------- autosave */

let notesTimer = null;
let lastSavedNotes = null;

/**
 * Notes typed after the recording is saved go back to disk. During a recording
 * they travel with the save itself, so nothing is written until then.
 *
 * my-notes.md is the user's verbatim record and note.md is the assistant's
 * write-up; saveNotes (new) targets the former. Without it, the old saveNote
 * is used only while no write-up exists, so a write-up is never overwritten
 * by a stray keystroke in the notes.
 */
function scheduleNotesSave() {
  clearTimeout(notesTimer);
  if (recording || !current?.dir) return;
  notesTimer = setTimeout(async () => {
    const text = $('notes')?.value ?? '';
    if (text === lastSavedNotes) return;
    try {
      if (typeof api.saveNotes === 'function') {
        await api.saveNotes(current.dir, text);
      } else if (!current.written && text.trim()) {
        await api.saveNote(current.dir, text);
      } else {
        return;
      }
      lastSavedNotes = text;
    } catch (e) {
      setStatus('Could not save notes: ' + e.message, 'warn');
    }
  }, 800);
}

async function saveWriteUp() {
  const text = $('pasteNote')?.value ?? '';
  if (!current?.dir) return;
  try {
    const r = await api.saveNote(current.dir, text);
    setStatus(`Write-up saved (${r.chars.toLocaleString()} chars).`, 'good');
    const paste = $('pasteNote');
    if (paste) paste.value = '';
    await reloadCurrent();
  } catch (e) { setStatus(e.message, 'warn'); }
}

/* ============================================================== exports */

/**
 * Wire #viewNote once. `api` is window.api; `onStatus(message, cls)` mirrors
 * every status line to the caller so the router can surface it elsewhere.
 */
export function initNote({ api: bridge, onStatus } = {}) {
  api = bridge ?? window.api;
  onStatusCb = typeof onStatus === 'function' ? onStatus : null;

  initLevelBars();
  initMicPill();
  setRecLabel('Record');
  initProviders();

  $('recBtn')?.addEventListener('click', () => (recording ? stopRec() : start()));
  $('write')?.addEventListener('click', (e) => writeUp(e.currentTarget));
  $('openFolder')?.addEventListener('click', () =>
    api.openFolder(current?.dir).catch((err) => setStatus('Could not open the folder: ' + err.message, 'warn')));
  // The pill replaces the old toggle button: same job, plus the recording tell.
  $('micPill')?.addEventListener('click', () => {
    $('transcriptPanel')?.classList.toggle('hide');
    syncPill();
  });
  $('copyTranscript')?.addEventListener('click', async () => {
    const text = transcriptText();
    if (!text) return setStatus('Nothing in the transcript yet.', 'warn');
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Transcript copied (${currentSegments.length} lines).`, 'good');
    } catch (e) {
      setStatus('Could not copy: ' + e.message, 'warn');
    }
  });
  $('notes')?.addEventListener('input', scheduleNotesSave);
  $('saveWriteUp')?.addEventListener('click', saveWriteUp);

  // Segments stream in only while a session runs, so one subscription for the
  // life of the window is enough; each is guarded so a missing bridge method
  // during integration does not break the view.
  try {
    api.onLiveSegment?.((seg) => {
      if (!live.active && !recording) return;
      if (seg?.echo) return;
      currentSegments.push(seg);
      appendBubble($('bubbles'), seg);
    });
  } catch {}
  try {
    api.onLiveStatus?.((s) => {
      if (!recording || !s) return;
      if (s.state === 'loading') {
        setStatus('Loading speech model...' + progressText(s.progress));
      } else if (s.state === 'ready') {
        setStatus('Recording. Live transcript on.');
      } else if (s.state === 'error') {
        // Recoverable errors (a restarted worker) keep the session; anything
        // else ends the live push and leaves the recording alone.
        if (!s.recoverable) live.active = false;
        setStatus('Live transcript: ' + (s.message ?? 'error') + '. The recording continues.', 'warn');
      }
    });
  } catch {}

  /*
   * The floating indicator has none of this window's DOM to click, so its
   * buttons arrive here as commands. 'stop' takes the Stop button's own path
   * rather than a shortcut, so the save, the live finish and the button state
   * all happen exactly as they do from inside the note. 'focus' is handled in
   * main, which raises this window itself; there is nothing to do here.
   */
  try {
    api.onIndicatorCommand?.((cmd) => {
      if (cmd === 'stop' && recording) stopRec();
    });
  } catch { /* no floating window in this build; the note view is unaffected */ }

  window.addEventListener('beforeunload', (e) => {
    if (recording) { e.preventDefault(); e.returnValue = ''; }
  });
}

function progressText(progress) {
  if (progress == null) return '';
  let pct = null;
  if (typeof progress === 'number') pct = progress <= 1 ? progress * 100 : progress;
  else if (progress && progress.total) pct = (progress.received / progress.total) * 100;
  return pct == null ? '' : ` ${Math.min(100, Math.max(0, pct)).toFixed(0)}%`;
}

/**
 * Show a saved meeting. `meeting` is a list summary or a full record; the body
 * is re-read from disk either way so the view never trusts a stale copy.
 * Refused while recording: the view is the recording until Stop.
 */
export async function openMeeting(meeting) {
  if (recording || starting) {
    setStatus('Stop the recording before opening another note.', 'warn');
    return false;
  }
  const dir = typeof meeting === 'string' ? meeting : meeting?.dir;
  if (!dir) return false;
  let m = null;
  try { m = await api.readMeeting(dir); } catch (e) {
    setStatus('Could not open: ' + e.message, 'warn');
    return false;
  }
  if (!m) { setStatus('That meeting is no longer on disk.', 'warn'); return false; }

  clearTimeout(notesTimer);
  current = m;
  calendarEvent = m.meta?.calendarEvent ?? null;
  const title = $('noteTitle');
  if (title) title.value = m.title ?? '';
  const notes = $('notes');
  if (notes) notes.value = m.notes ?? '';
  lastSavedNotes = m.notes ?? '';
  renderMeta({
    startedAt: m.startedAt ?? m.meta?.startedAt,
    endedAt: m.meta?.endedAt,
    durationSeconds: m.durationSeconds,
    calendarEvent,
    autoTitled: Boolean(calendarEvent),
  });
  $('writeRow')?.classList.remove('hide');
  if (!m.transcript) $('transcriptPanel')?.classList.add('hide');
  showTranscript(m);
  showWriteUp(m);
  const clock = $('clock');
  if (clock) clock.textContent = '00:00';
  return true;
}

/**
 * Clear the view for a fresh note. `prefill` = {title, calendarEvent} when the
 * user started from an agenda row. Refused while recording.
 */
export function newNote(prefill) {
  if (recording || starting) {
    setStatus('Stop the recording before starting another note.', 'warn');
    return false;
  }
  clearTimeout(notesTimer);
  current = null;
  currentSegments = [];
  lastSavedNotes = null;
  calendarEvent = prefill?.calendarEvent ?? null;

  const title = $('noteTitle');
  if (title) title.value = prefill?.title ?? calendarEvent?.title ?? '';
  const notes = $('notes');
  if (notes) notes.value = '';
  const paste = $('pasteNote');
  if (paste) paste.value = '';
  renderMeta(calendarEvent
    ? { startedAt: calendarEvent.start, endedAt: calendarEvent.end, calendarEvent, autoTitled: !prefill?.title }
    : null);
  $('writeRow')?.classList.add('hide');
  $('pasteRow')?.classList.add('hide');
  $('writeUp')?.classList.add('hide');
  $('bubbles')?.replaceChildren();
  $('transcriptPanel')?.classList.add('hide');
  syncPill();
  const clock = $('clock');
  if (clock) clock.textContent = '00:00';
  return true;
}

export function isRecording() {
  return recording || starting;
}
