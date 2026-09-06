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
import { PROVIDERS } from './settings-view.js';
import { segmentsOf as segmentsOfMeta } from './meeting-schema.js';
import {
  renderBubbles, appendBubble, segmentsFromTranscript, enableBubbleCopy, filterBubbles,
} from './conversation.js';

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
// Track ids already reported as muted or ended, so the 250 ms poll records
// the transition rather than the condition. Cleared with deviceEvents.
let mutedTracks = new Set();

/*
 * Stop ends the capture, not the note, and Resume starts another capture into
 * the same folder. Three numbers keep that honest:
 *
 *   meetingStartedAt  when the FIRST capture began, so a resumed capture knows
 *                     where it sits on the meeting's clock and its transcript
 *                     lines land after the earlier ones instead of on top.
 *   capturedBefore    seconds of audio already on disk, so the clock shows the
 *                     meeting's length and not just this segment's.
 *   segmentIndex      which capture this is, so the right wav files are the
 *                     ones deleted when the transcript is safely written.
 */
let meetingStartedAt = 0;
let capturedBefore = 0;
let segmentIndex = 0;
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
/*
 * Audio goes to disk while the meeting runs, a few seconds at a time.
 *
 * Before this, every sample stayed in T.mic.chunks and T.sys.chunks until Stop,
 * and only then crossed to main to be written. Two things were wrong with that.
 * A crash, a power cut or a forced Windows restart lost the whole meeting,
 * because nothing had been written yet. And the memory grew for the length of
 * the recording: Float32 at 16 kHz on two tracks is 128 KB a second, so the
 * three hours MAX_MINUTES allows is about 1.3 GiB, briefly doubled while the
 * save copied it.
 *
 * Now each flush hands its blocks over and lets go of them, so what this window
 * holds is a few seconds, not a meeting. FLUSH_MS is the size of the hole a
 * power cut can still make: four seconds is small enough not to matter and long
 * enough that the write happens a few times a minute rather than constantly.
 */
const FLUSH_MS = 4000;

let captureDir = '';        // the meeting folder main is writing into
let flushTimer = null;
let flushChain = Promise.resolve();
let flushWarned = false;

/** Float32 blocks to the 16-bit PCM the wav holds, clamped the same way. */
function toPcm16(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      out[at++] = Math.round(s * 32767);
    }
  }
  return out;
}

/**
 * Hand over everything captured since the last flush.
 *
 * Chained rather than parallel, and the chunks are taken before the first await:
 * two flushes in flight at once would interleave their samples in the file, and
 * a block arriving mid-flush must belong to the next one, not this one.
 */
function flushCapture() {
  if (!captureDir) return flushChain;

  const work = [];
  for (const [key, track] of [['mic', 'mic'], ['sys', 'system']]) {
    const chunks = T[key].chunks;
    if (!chunks.length) continue;
    T[key].chunks = [];
    work.push([track, toPcm16(chunks)]);
  }
  if (!work.length) return flushChain;

  flushChain = flushChain.then(async () => {
    for (const [track, pcm] of work) {
      const r = await api.captureAppend(
        captureDir, track, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      );
      // Said once. A disk that has stopped accepting writes will fail every
      // flush, and a warning every four seconds tells the user nothing new.
      if (r && r.ok === false && !flushWarned) {
        flushWarned = true;
        setStatus(
          'Could not write audio to disk: ' + (r.error ?? 'unknown') +
          ' The recording is still running, but expect a gap.', 'warn');
      }
    }
  }).catch(() => { /* reported above; never break the recording */ });

  return flushChain;
}

function teardownCapture() {
  clearInterval(tick); clearTimeout(capTimer);
  clearInterval(levelTimer); clearInterval(stateTimer);
  clearInterval(flushTimer); flushTimer = null;
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
  mutedTracks = new Set();
}

/* ---------------------------------------------------------------- levels */

/*
 * One meter, the pill. There were three: the pill, and a pair of five-bar
 * clusters beside it showing the same two numbers again. Removing the clusters
 * removed the only thing that needed a bar list, so the paint loop is now just
 * the pill, which is also the meter the floating window mirrors.
 */
function paintLevels(silent = false) {
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
/**
 * What the Record button offers, and what the clock shows, for whatever meeting
 * is open. A note with a folder behind it can be carried on with, so the button
 * says Resume and the clock keeps the meeting's captured length rather than
 * resetting to zero and implying the audio is gone.
 */
function syncRecControl() {
  const resumable = Boolean(current?.dir);
  setRecLabel(resumable ? 'Resume' : 'Record');
  const clock = $('clock');
  if (!clock) return;
  const seconds = resumable ? Number(current?.durationSeconds) || 0 : 0;
  const s = Math.floor(seconds);
  clock.textContent =
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Drop any active search. Called whenever the bubbles are replaced: a filter
 * left over from the previous note would silently hide most of the new one, and
 * the user has no reason to connect the empty card to a box they typed in
 * minutes ago.
 */
function clearTranscriptSearch() {
  const search = $('transcriptSearch');
  if (search) search.value = '';
  const count = $('transcriptCount');
  if (count) count.textContent = '';
}

/**
 * Re-run whatever is in the search box. Called on every keystroke and again on
 * every line that streams in, so the card never shows a mix of filtered and
 * unfiltered speech.
 */
function applyTranscriptSearch() {
  const bubbles = $('bubbles');
  const search = $('transcriptSearch');
  if (!bubbles || !search) return;
  const q = search.value;
  const n = filterBubbles(bubbles, q);
  const count = $('transcriptCount');
  if (!count) return;
  // Silent when the box is empty: a count beside an empty search box is noise,
  // and the number it would show is just "all of them". The denominator is what
  // is on screen rather than what is in memory, because consecutive lines from
  // one speaker fold into a single bubble.
  const total = bubbles.querySelectorAll('.bubble').length;
  count.textContent = q.trim() ? `${n} of ${total}` : '';
}

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
/**
 * Seconds of audio actually captured. The floating window shows this rather
 * than counting for itself, because it is destroyed and rebuilt with the
 * recording and a window that restarted its own clock would disagree with the
 * note it belongs to.
 */
function capturedSeconds() {
  const now = recording && startedAt ? (Date.now() - startedAt) / 1000 : 0;
  // The meeting's captured time, not this segment's: a Resume shows the clock
  // carrying on from where Stop left it, which is what the user expects of a
  // meeting that was paused rather than of a second recording.
  return capturedBefore + now;
}

function pushRecordingState() {
  try {
    api?.recordingState?.({
      recording,
      elapsed: capturedSeconds(),
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
/*
 * Four seconds in, say whether the two tracks are alive.
 *
 * The microphone is the one that can be wrong: a silent mic four seconds into
 * a recording is the wrong device or a muted one, and that is worth a warning
 * and a re-check every two seconds until it clears. System audio is different.
 * It carries the far end of a call, and it is silent whenever nothing is
 * playing, which is every solo test anyone ever does. Calling that "wrong
 * device, or muted", in red, every two seconds, alternating with whatever the
 * live transcript was trying to say, was noise dressed as a diagnosis. It gets
 * one calm line, once.
 */
function checkSignal() {
  const mic = T.mic;
  if (mic.peak < 1e-4) {
    setStatus(
      mic.frames === 0
        ? 'Your microphone has delivered no audio yet.'
        : 'Your microphone is delivering audio but it is silent: wrong device, or muted.',
      'warn');
    if (recording) capTimer = setTimeout(checkSignal, 2000);
    return;
  }
  if (T.sys.peak < 1e-4) {
    setStatus('Recording. System audio is quiet so far, which is normal when nothing is playing.');
    return;
  }
  setStatus('Recording. Both channels have signal.');
}

function onDeviceChange() {
  deviceEvents.push({ at: Date.now() - startedAt, event: 'devicechange' });
  setStatus('Audio devices changed mid-recording. A gap may exist from here.', 'warn');
}

/** Ask the calendar what is on right now. Never throws, never blocks. */
async function start() {
  // Several awaits happen before the button is disabled. Without this guard a
  // second click attaches a second pair of worklet nodes to the same buffers;
  // the frame counters then disagree with the data and concat() throws on Stop,
  // outside the try, losing the meeting and wedging the button.
  if (recording || starting) return;
  /*
   * A saved meeting open in this view is RESUMED, not replaced. This is the one
   * behaviour change a user will notice: pressing Record with a note open used
   * to silently start a second note, so a meeting stopped for a five minute
   * break came back as two unrelated recordings that had to be reconciled by
   * hand. "+ New note" is how you start a fresh one, and the button says
   * Resume rather than Record whenever that is what it will do.
   *
   * A meeting with no folder on disk is not resumable, so that still starts new.
   */
  if (current && !current.dir) newNote();
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
  /*
   * Resuming an existing meeting, or beginning a new one. Read from `current`,
   * which is whatever is on disk, rather than from a counter kept in this
   * window: the user may have quit and come back, and the folder is the only
   * thing that knows how much of this meeting has already been recorded.
   */
  if (current?.dir) {
    const prior = segmentsOfMeta(current.meta);
    meetingStartedAt = Date.parse(prior[0]?.startedAt ?? current.startedAt ?? '') || startedAt;
    capturedBefore = prior.reduce((n, x) => n + (Number(x.durationSeconds) || 0), 0);
    segmentIndex = prior.length + 1;
  } else {
    meetingStartedAt = startedAt;
    capturedBefore = 0;
    segmentIndex = 1;
  }
  /*
   * Open the meeting folder before the recording is live, and fail the whole
   * start if it cannot be opened. A recording that cannot reach disk cannot be
   * saved either; learning that now costs nothing, and learning it at Stop
   * costs the meeting.
   */
  try {
    const begun = await api.captureBegin({
      dir: current?.dir,
      startedAt,
      title: $('noteTitle')?.value.trim() ?? '',
      sampleRate: ctx.sampleRate,
      calendarEvent,
    });
    captureDir = begun.dir;
    flushWarned = false;
  } catch (e) {
    try { await ctx?.close(); } catch {}
    ctx = null;
    return fail('The meeting folder could not be opened for writing: ' + e.message + ' Nothing was recorded.');
  }

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

  /*
   * autoTitle() used to run here, and that was the bug: every recording adopted
   * whatever calendar event was nearest, so an impromptu note started with
   * "+ New note" came out titled after a meeting the user was not in.
   *
   * Granola's own documentation draws the line the other way round. New Note is
   * for "an ad-hoc meeting or call that isn't on your calendar", and those
   * notes "won't be linked to your calendar"; a note becomes a calendar note by
   * being opened FROM the meeting, not by being recorded near it. So the link
   * is made at the point the user picks the meeting, in home.js, and pressing
   * Record here changes nothing about what this note is.
   */
  applyOnTop(true);
  startLive();

  levelTimer = setInterval(() => paintLevels(), Math.round(1000 / LEVEL_FPS));
  stateTimer = setInterval(pushRecordingState, Math.round(1000 / STATE_FPS));
  flushTimer = setInterval(flushCapture, FLUSH_MS);

  tick = setInterval(() => {
    const s = Math.floor(capturedSeconds());
    const clock = $('clock');
    if (clock) clock.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    // A driver that fails in place fires no event and keeps feeding zeros, so the
    // latched peak still reads healthy. `muted` is what actually catches it.
    /*
     * Latched. This runs four times a second, and without the latch a muted
     * microphone wrote four events a second into meeting.json for the rest of
     * the meeting: an hour of a muted mic was 14,400 identical entries, and the
     * status line said the same sentence over and over. What matters is the
     * transition, so only the transition is recorded.
     */
    for (const st of Object.values(streams)) {
      for (const tr of st?.getAudioTracks() ?? []) {
        const bad = tr.muted || tr.readyState === 'ended';
        if (bad && !mutedTracks.has(tr.id)) {
          mutedTracks.add(tr.id);
          deviceEvents.push({ at: Date.now() - startedAt, event: 'track-muted', label: tr.label });
          setStatus(`"${tr.label || 'a device'}" went silent mid-recording.`, 'warn');
        } else if (!bad && mutedTracks.delete(tr.id)) {
          // Worth writing down: it says where the gap ends.
          deviceEvents.push({ at: Date.now() - startedAt, event: 'track-recovered', label: tr.label });
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
    const r = await api.liveStart({
      title: $('noteTitle')?.value.trim() ?? '',
      // Zero on a first capture. On a Resume this is the wall gap since the
      // meeting began, which is what puts the new lines on the meeting clock.
      offsetSeconds: meetingStartedAt ? Math.max(0, (startedAt - meetingStartedAt) / 1000) : 0,
    });
    if (!recording) return;
    if (!r?.ok) {
      setStatus('Live transcript unavailable (' + (r?.error ?? 'unknown') + '). Recording continues; transcribe after.', 'warn');
      return;
    }
    live = { active: true, frames: newLiveFrames() };
    $('transcriptPanel')?.classList.remove('hide');
    syncPill();
    clearTranscriptSearch();
    // Resuming keeps what was already said on screen and appends to it. Wiping
    // it would look like the first half of the meeting had been lost, and the
    // new lines carry meeting-clock timestamps that follow on from these.
    renderBubbles($('bubbles'), currentSegments, { live: true });
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

  let saved = null;
  try {
    // The tail. Everything else went down while the meeting was running.
    await flushCapture();
    await flushChain;

    const { dir, meta, segment } = await api.saveMeeting({
      /*
       * The audio is already in the folder, written as it arrived. This asks
       * main to close the two files, measure them and give them their real
       * names, so nothing crosses the bridge here except the meeting's text.
       */
      streamed: true,
      dir: captureDir,
      startedAt, endedAt,
      title: $('noteTitle')?.value.trim() ?? '',
      notes: $('notes')?.value ?? '',
      sampleRate: sr,
      timeline: {
        deviceEvents,
        mic: { renderBlocks: T.mic.blocks, emptyBlocks: T.mic.empty },
        system: { renderBlocks: T.sys.blocks, emptyBlocks: T.sys.empty },
      },
      calendarEvent,
    });
    saved = { dir, meta, segment };
    lastSavedTitle = $('noteTitle')?.value.trim() ?? '';
    current = {
      dir, title: meta.title, startedAt: meta.startedAt, endedAt: meta.endedAt,
      durationSeconds: meta.durationSeconds,
      transcribed: Boolean(meta.transcript), written: current?.written ?? false, meta,
    };
    // What a further Resume would append to, so the clock carries on and the
    // next segment gets the right index even without reloading from disk.
    capturedBefore = Number(meta.durationSeconds) || capturedBefore;
    segmentIndex = segment?.index ?? segmentIndex;
    $('writeRow')?.classList.remove('hide');
    renderMeta({ ...meta, meta, calendarEvent, fromCalendar: Boolean(calendarEvent) });

    const bad = Object.entries(meta.tracks).filter(([, t]) => t.silent).map(([k]) => k);
    if (bad.length) setStatus(`Saved, but ${bad.join(' and ')} captured silence.`, 'warn');
    else if (deviceEvents.length) setStatus(
      `Saved ${meta.durationSeconds.toFixed(0)}s, but an audio device changed or ` +
      `stopped during the recording. Check the transcript for gaps.`, 'warn');
    else setStatus(
      `Saved ${meta.durationSeconds.toFixed(0)}s. You ${meta.tracks.mic.voicedSeconds}s, ` +
      `them ${meta.tracks.system.voicedSeconds}s.`, 'good');
  } catch (e) {
    /*
     * The audio is not at risk here, which is the whole point of writing it as
     * it arrived. What failed is the bookkeeping around it, and the folder
     * still holds both wavs and the marker that says the recording is
     * unfinished, so the next launch assembles it.
     */
    setStatus(
      'Save failed: ' + e.message +
      ' The audio itself is safe in the meeting folder, and MIN will finish ' +
      'saving it the next time it starts.', 'warn');
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
  // The note is still open and still has a folder behind it, so the button
  // offers to carry on with it rather than to start something unrelated.
  syncRecControl();
}

async function finishLive(saved) {
  live.active = false;
  let result = null;
  try {
    setStatus('Finishing the live transcript...');
    // The folder the save above produced. Without it main has nowhere to put
    // transcript.md, which is how every live transcript used to be discarded.
    result = await api.liveStop(saved?.dir, saved?.segment?.index);
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
    clearTranscriptSearch();
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
  // The card's footer button is the same control in a second place. Driven from
  // here rather than from each caller, so the two can never disagree about
  // whether this meeting is running.
  const foot = $('transcriptToggle');
  if (foot) {
    foot.textContent = text;
    foot.title = text === 'Stop' ? 'Stop capturing' : 'Start capturing into this note';
  }
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
 * endedAt, durationSeconds, calendarEvent, fromCalendar.
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
  if (start && end) chip(`${fmtTime(start)} – ${fmtTime(end)}`, 'time');
  else if (start) chip(fmtTime(start), 'time');

  const dur = info?.durationSeconds ??
    (ev?.start && ev?.end ? (new Date(ev.end) - new Date(ev.start)) / 1000 : null);
  if (dur) chip(fmtDuration(dur), 'duration');

  /*
   * Only once a meeting has actually been stopped and resumed. Then the
   * duration chip is captured time and the span is the wall window, and
   * without saying so a 40 minute chip on a meeting the user remembers as an
   * hour looks like lost audio rather than a break they took.
   */
  const parts = segmentsOfMeta(info?.meta ?? info).length;
  if (parts > 1) {
    const span = Number((info?.meta ?? info)?.spanSeconds) || 0;
    chip(span ? `${parts} parts over ${fmtDuration(span)}` : `${parts} parts`, 'segments');
  }

  const names = attendeeNames(ev);
  const count = names.length || Number(ev?.attendeeCount) || 0;
  if (count) chip(`${count} attendee${count === 1 ? '' : 's'}`, 'attendees');
  if (ev?.recurring) chip('Recurring', 'recurring');
  // Named for where the note came from, not for how the title got there: the
  // meeting is picked from Coming up now, so nothing is automatic about it.
  if (info?.fromCalendar) chip('From calendar', 'auto');
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
    clearTranscriptSearch();
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
let titleTimer = null;
let lastSavedTitle = null;

/**
 * Save the title as it is typed, debounced, and immediately on `change`.
 *
 * Nothing listened to this field before. The title reached disk once, inside
 * the save at Stop, so a title typed afterwards, or corrected afterwards, was
 * simply not the meeting's title anywhere but on this screen, and Home went on
 * saying Untitled.
 */
function scheduleTitleSave(immediate = false) {
  clearTimeout(titleTimer);
  const dir = current?.dir || (recording ? captureDir : '');
  if (!dir || typeof api.saveTitle !== 'function') return Promise.resolve();
  const run = async () => {
    const title = $('noteTitle')?.value.trim() ?? '';
    if (title === lastSavedTitle) return;
    try {
      const r = await api.saveTitle(dir, title);
      lastSavedTitle = title;
      if (current && current.dir === dir) current.title = r?.title ?? title;
    } catch (e) {
      setStatus('Could not save the title: ' + e.message, 'warn');
    }
  };
  if (immediate) return run();
  titleTimer = setTimeout(run, 600);
  return Promise.resolve();
}

/**
 * Everything the note pane still owes the disk, written now. The router calls
 * this on the way to Home, so the list it is about to draw reads the title and
 * notes the user just typed rather than the ones from 600 ms ago.
 */
export async function flushNoteSaves() {
  await Promise.all([scheduleTitleSave(true), scheduleNotesSave(true)]);
}

function scheduleNotesSave(immediate = false) {
  clearTimeout(notesTimer);
  /*
   * This used to bail while recording, because until the capture was saved
   * there was no folder to write into. The folder now exists from the moment
   * Record is pressed, so the notes go to disk as they are typed: a crash keeps
   * them, and anything reading the folder during the meeting (the MCP server,
   * so Claude Desktop) sees them beside the live transcript.
   */
  const dir = current?.dir || (recording ? captureDir : '');
  if (!dir) return Promise.resolve();
  const run = async () => {
    const text = $('notes')?.value ?? '';
    if (text === lastSavedNotes) return;
    try {
      if (typeof api.saveNotes === 'function') {
        await api.saveNotes(dir, text);
      } else if (!current?.written && text.trim()) {
        await api.saveNote(dir, text);
      } else {
        return;
      }
      lastSavedNotes = text;
    } catch (e) {
      setStatus('Could not save notes: ' + e.message, 'warn');
    }
  };
  if (immediate) return run();
  notesTimer = setTimeout(run, 800);
  return Promise.resolve();
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
  $('closeTranscript')?.addEventListener('click', () => {
    $('transcriptPanel')?.classList.add('hide');
    syncPill();
  });
  // The footer button and the bar button are the same control. One handler.
  $('transcriptToggle')?.addEventListener('click', () => (recording ? stopRec() : start()));

  // Click a line to copy it, in the transcript's own format. Delegated inside
  // conversation.js, so it keeps working as bubbles stream in mid-recording.
  const bubbles = $('bubbles');
  if (bubbles) {
    enableBubbleCopy(bubbles, (line, err) =>
      err
        ? setStatus('Could not copy: ' + (err.message ?? err), 'warn')
        : setStatus('Line copied.', 'good'));
    $('transcriptSearch')?.addEventListener('input', applyTranscriptSearch);
  }
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
  $('notes')?.addEventListener('input', () => scheduleNotesSave());
  $('noteTitle')?.addEventListener('input', () => scheduleTitleSave());
  // Leaving the field (a click elsewhere, Tab, Enter then blur) saves at once.
  $('noteTitle')?.addEventListener('change', () => scheduleTitleSave(true));
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
      // A line that lands while a search is open has to face the same filter
      // the rest of the card is under. Without this it appears unfiltered in a
      // filtered list, and the count beside the box goes stale.
      applyTranscriptSearch();
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
  clearTimeout(titleTimer);
  current = m;
  calendarEvent = m.meta?.calendarEvent ?? null;
  const title = $('noteTitle');
  if (title) title.value = m.title ?? '';
  lastSavedTitle = m.title ?? '';
  const notes = $('notes');
  if (notes) notes.value = m.notes ?? '';
  lastSavedNotes = m.notes ?? '';
  renderMeta({
    startedAt: m.startedAt ?? m.meta?.startedAt,
    endedAt: m.meta?.endedAt,
    durationSeconds: m.durationSeconds,
    calendarEvent,
    fromCalendar: Boolean(calendarEvent),
    meta: m.meta,
  });
  $('writeRow')?.classList.remove('hide');
  if (!m.transcript) $('transcriptPanel')?.classList.add('hide');
  showTranscript(m);
  showWriteUp(m);
  // Opened from disk, so the counters this window kept are meaningless until
  // start() reads them back out of the folder.
  meetingStartedAt = 0;
  capturedBefore = 0;
  segmentIndex = 0;
  syncRecControl();
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

  /*
   * A note that has never been recorded has no folder, so its text lives only
   * in this textarea: scheduleNotesSave bails without a dir, and nothing else
   * writes it. Replacing it used to blank it with no warning.
   *
   * That was survivable while the only way here was the user's own click. It
   * stopped being survivable with the meeting prompt, which arrives on the
   * calendar's schedule: type an agenda for ten minutes, have a prompt appear
   * for an unrelated meeting, press "Take notes", and every word is gone at a
   * moment nobody chose. So ask. The answer is only ever needed for text that
   * has nowhere else to be.
   */
  const pending = current?.dir ? '' : ($('notes')?.value ?? '').trim();
  if (pending && !confirm(
    'This note has not been recorded, so its text is not saved anywhere yet. ' +
    'Starting another note will discard it.\n\nDiscard and continue?')) {
    return false;
  }

  clearTimeout(notesTimer);
  clearTimeout(titleTimer);
  lastSavedTitle = null;
  captureDir = '';
  current = null;
  currentSegments = [];
  lastSavedNotes = null;
  calendarEvent = prefill?.calendarEvent ?? null;
  meetingStartedAt = 0;
  capturedBefore = 0;
  segmentIndex = 0;

  const title = $('noteTitle');
  if (title) title.value = prefill?.title ?? calendarEvent?.title ?? '';
  const notes = $('notes');
  if (notes) notes.value = '';
  const paste = $('pasteNote');
  if (paste) paste.value = '';
  renderMeta(calendarEvent
    ? { startedAt: calendarEvent.start, endedAt: calendarEvent.end, calendarEvent, fromCalendar: true }
    : null);
  $('writeRow')?.classList.add('hide');
  $('pasteRow')?.classList.add('hide');
  $('writeUp')?.classList.add('hide');
  $('bubbles')?.replaceChildren();
  $('transcriptPanel')?.classList.add('hide');
  syncPill();
  syncRecControl();
  return true;
}

/**
 * Start recording the note that is already open. The meeting prompt uses this:
 * it has just opened a note for the meeting, and pressing "Take notes" means
 * record it, so the alternative would be synthesising a click on #recBtn.
 *
 * Returns false when a recording is already running, which the caller reports;
 * silently starting a second one is how you lose the first.
 */
export function startRecording() {
  if (recording || starting) return false;
  start();
  return true;
}

export function isRecording() {
  return recording || starting;
}
