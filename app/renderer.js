/*
 * Renderer. Owns capture, the two views, and every DOM update.
 *
 * This lives in its own file rather than inline in index.html so the
 * Content-Security-Policy can authorise it with script-src 'self'. The inline
 * form needed a sha256 of the script text, which silently blanked the window
 * whenever anyone edited a byte and forgot to recompute it.
 *
 * Loaded as a module, so it is deferred and the DOM is parsed before it runs.
 */
import { renderMarkdown, renderTranscript } from './md.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const setStatus = (m, cls = '') => { statusEl.className = cls; statusEl.textContent = m; };
const esc = (s) => (s ?? '').replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));

/* ═══════════════════════════════ recording ═══════════════════════════════ */

const SAMPLE_RATE = 16000;   // what the recogniser wants; the browser resamples
const MAX_MINUTES = 180;

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.blocks = 0; this.empty = 0; this.frames = 0; }
  process(inputs) {
    this.blocks++;
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) { this.empty++; return true; }
    this.frames += ch.length;
    let peak = 0;
    for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > peak) peak = a; }
    this.port.postMessage({ pcm: ch.slice(0), peak, frames: this.frames, blocks: this.blocks, empty: this.empty });
    return true;
  }
}
registerProcessor('tap', Tap);
`;

const T = {
  mic: { chunks: [], frames: 0, empty: 0, blocks: 0, peak: 0, lvl: $('micLvl'), val: $('micVal') },
  sys: { chunks: [], frames: 0, empty: 0, blocks: 0, peak: 0, lvl: $('sysLvl'), val: $('sysVal') },
};

let ctx = null, streams = {}, nodes = [], recording = false;
let startedAt = 0, tick = null, deviceEvents = [], capTimer = null, lastDir = null;
let starting = false;   // start() awaits three times before disabling the button

/** Release every device and node. Safe to call twice. */
function teardownCapture() {
  clearInterval(tick); clearTimeout(capTimer);
  for (const n of nodes) { try { n.disconnect(); } catch {} }
  nodes = [];
  for (const st of Object.values(streams)) st?.getTracks().forEach((t) => t.stop());
  streams = {};
}

function resetTracks() {
  for (const k of ['mic', 'sys']) {
    Object.assign(T[k], { chunks: [], frames: 0, empty: 0, blocks: 0, peak: 0 });
    T[k].lvl.style.width = '0';
    T[k].val.textContent = '';
  }
  deviceEvents = [];
}

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
    t.lvl.style.width = Math.min(100, Math.sqrt(data.peak) * 130) + '%';
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
  if (!problems.length) return setStatus('● Recording. Both channels have signal.');
  setStatus('⚠ ' + problems.join('. ') + '.', 'warn');
  if (recording) capTimer = setTimeout(checkSignal, 2000);
}

function onDeviceChange() {
  deviceEvents.push({ at: Date.now() - startedAt, event: 'devicechange' });
  setStatus('⚠ Audio devices changed mid-recording. A gap may exist from here.', 'warn');
}

async function start() {
  // Three awaits happen before the button is disabled. Without this guard a
  // second click attaches a second pair of worklet nodes to the same buffers;
  // the frame counters then disagree with the data and concat() throws on Stop,
  // outside the try, losing the meeting and wedging both buttons.
  if (recording || starting) return;
  starting = true;
  $('rec').disabled = true;

  teardownCapture();
  resetTracks();
  $('after').classList.add('hide');
  setStatus('Requesting microphone…');

  try {
    streams.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) { return fail('Microphone unavailable: ' + e.message); }

  setStatus('Requesting system audio…');
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
        setStatus(`⚠ "${tr.label || 'a device'}" stopped mid-recording. Audio from here is lost.`, 'warn');
      }));
  }

  startedAt = Date.now();
  recording = true;
  starting = false;
  $('stopBtn').disabled = false;
  $('rec').classList.add('rec-on');
  $('clock').classList.add('live');
  setStatus('● Recording…');

  tick = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('clock').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    for (const k of ['mic', 'sys']) T[k].val.textContent = (T[k].frames / SAMPLE_RATE).toFixed(0) + 's';
    // A driver that fails in place fires no event and keeps feeding zeros, so the
    // latched peak still reads healthy. `muted` is what actually catches it.
    for (const st of Object.values(streams)) {
      for (const tr of st?.getAudioTracks() ?? []) {
        if (tr.muted || tr.readyState === 'ended') {
          deviceEvents.push({ at: Date.now() - startedAt, event: 'track-muted', label: tr.label });
          setStatus(`⚠ "${tr.label || 'a device'}" went silent mid-recording.`, 'warn');
        }
      }
    }
    if (s > MAX_MINUTES * 60) stopRec();
  }, 250);

  capTimer = setTimeout(checkSignal, 4000);
}

function fail(msg) {
  teardownCapture();
  starting = false;
  $('rec').disabled = false;
  $('rec').classList.remove('rec-on');
  setStatus(msg, 'warn');
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
  $('stopBtn').disabled = true;
  $('clock').classList.remove('live');
  setStatus('Saving…');

  const endedAt = Date.now();
  const sr = ctx.sampleRate;
  teardownCapture();
  try { await ctx.close(); } catch {}

  // Held outside the try so a failed save can hand the PCM back. The chunk
  // arrays are still released before the save, so the success path never holds
  // two copies of a three-hour recording at once.
  let mic = null, sys = null;
  try {
    mic = concat(T.mic.chunks);
    sys = concat(T.sys.chunks);
    T.mic.chunks = []; T.sys.chunks = [];
    const { dir, meta } = await window.api.saveMeeting({
      startedAt, endedAt,
      title: $('title').value.trim(),
      notes: $('notes').value,
      sampleRate: sr,
      mic: new Uint8Array(mic.buffer),
      system: new Uint8Array(sys.buffer),
      timeline: {
        deviceEvents,
        mic: { renderBlocks: T.mic.blocks, emptyBlocks: T.mic.empty },
        system: { renderBlocks: T.sys.blocks, emptyBlocks: T.sys.empty },
      },
    });
    lastDir = dir;
    $('after').classList.remove('hide');

    const bad = Object.entries(meta.tracks).filter(([, t]) => t.silent).map(([k]) => k);
    if (bad.length) setStatus(`⚠ Saved, but ${bad.join(' and ')} captured silence.`, 'warn');
    else if (deviceEvents.length) setStatus(
      `⚠ Saved ${meta.durationSeconds.toFixed(0)}s, but an audio device changed or ` +
      `stopped during the recording. Check the transcript for gaps.`, 'warn');
    else setStatus(
      `✓ Saved ${meta.durationSeconds.toFixed(0)}s · you ${meta.tracks.mic.voicedSeconds}s ` +
      `· them ${meta.tracks.system.voicedSeconds}s`, 'good');
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
    $('rec').disabled = false;
    $('rec').classList.remove('rec-on');
    $('clock').textContent = '00:00';
  }
}

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

function initProviders() {
  const sel = $('provider');
  sel.innerHTML = PROVIDERS.map(
    (p) => `<option value="${p.id}">${p.name}</option>`
  ).join('');
  let saved = null;
  try { saved = localStorage.getItem('provider'); } catch {}
  sel.value = saved ?? 'claude';
  if (!PROVIDERS.some((p) => p.id === sel.value)) sel.value = 'claude';
  sel.addEventListener('change', () => {
    try { localStorage.setItem('provider', sel.value); } catch {}
  });
}
initProviders();

/** Transcribe then put the write-up prompt on the clipboard. */
async function writeUp(dir, btn) {
  btn.disabled = true;
  try {
    const meeting = await window.api.readMeeting(dir);
    if (!meeting?.transcribed) {
      // On a fresh install this call also downloads ~640 MB. Promising a fast
      // transcription while silently fetching that is a lie. The range is the
      // measured one: 4.5 to 6 min per hour on a 6-core desktop, 7 to 9 on the
      // 4-core laptop this targets. Quote the span, never the best case.
      const ready = await window.api.modelsReady();
      setStatus(
        ready
          ? 'Transcribing on this machine, roughly 5 to 9 min per hour of audio…'
          : 'First run: downloading the ~640 MB speech model. This happens once.'
      );
      const t = await window.api.transcribe(dir);
      if (t.empty) {
        setStatus(
          'Nothing was recognised in this recording. The audio has been kept so you can try '
            + 'again: check the microphone and system-audio devices, then press Write up.',
          'warn'
        );
        return;
      }
      const echo = t.echoes ? ` (${t.echoes} echo line${t.echoes > 1 ? 's' : ''} removed)` : '';
      setStatus(`Transcribed ${t.count} utterances${echo}. Copying…`);
    }
    const p = await window.api.copyPrompt(dir);
    const providerId = $('provider')?.value ?? '';
    const providerName = PROVIDERS.find((x) => x.id === providerId)?.name ?? '';

    if (providerId) {
      await window.api.openProvider(providerId);
      setStatus(
        `✓ ~${p.words.toLocaleString()} words copied · ${providerName} opening. Press Ctrl+V, ` +
          `then paste the answer back under Write-up.`,
        'good'
      );
    } else {
      setStatus(`✓ Copied ~${p.words.toLocaleString()} words to the clipboard.`, 'good');
    }
    if (!$('viewLib').classList.contains('hide')) await openMeeting(dir);
  } catch (e) {
    setStatus('Failed: ' + e.message, 'warn');
  } finally { btn.disabled = false; }
}

$('rec').addEventListener('click', start);
$('stopBtn').addEventListener('click', stopRec);
$('openRec').addEventListener('click', () => window.api.openFolder(lastDir).catch((err) => setStatus('Could not open the folder: ' + err.message, 'warn')));
$('write').addEventListener('click', (e) => writeUp(lastDir, e.target));
$('ontop').addEventListener('change', (e) => window.api.setAlwaysOnTop(e.target.checked));
window.addEventListener('beforeunload', (e) => {
  if (recording) { e.preventDefault(); e.returnValue = ''; }
});

/* ═══════════════════════════════ meetings ════════════════════════════════ */

let meetings = [], current = null, dtab = 'notes';

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
const fmtDur = (s) => (s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);

/**
 * One render path for the sidebar.
 *
 * Everything that changes the list (clicking a row, saving a write-up, deleting)
 * used to call drawList(meetings, null) directly, which threw away the active
 * search. The rendered set is instead re-derived from the query box every time,
 * so a search survives interaction with its own results.
 */
let lastQuery = '';
let lastHits = null;   // { order: Map<dir,int>, snippets: {dir: html} }

function renderList() {
  const q = $('q').value.trim();
  let rows = meetings;
  let snippets = null;

  if (q && lastHits && lastQuery === q) {
    snippets = lastHits.snippets;
    rows = meetings
      .filter((m) => lastHits.order.has(m.dir))
      .sort((a, b) => lastHits.order.get(a.dir) - lastHits.order.get(b.dir));
  }

  if (!rows.length) {
    $('list').innerHTML = `<div class="row"><span class="snip">${
      q ? 'No matches.' : 'No meetings yet. Record one.'}</span></div>`;
    return;
  }

  $('list').innerHTML = rows.map((m, i) => {
    const hit = snippets?.[m.dir];
    return `<div class="row ${current === m.dir ? 'on' : ''}" data-i="${i}">
      <span class="t">${esc(m.title)}</span>
      <span class="m">
        <span class="pip ${m.written ? 'p-wr' : m.transcribed ? 'p-tx' : 'p-no'}"></span>
        ${fmtDate(m.startedAt)} · ${fmtDur(m.durationSeconds)}
      </span>
      ${hit ? `<span class="snip">${hit}</span>` : ''}
    </div>`;
  }).join('');

  // Close over the row object rather than round-tripping the path through a DOM
  // attribute: esc() does not escape quotes, and a path never needs to be markup.
  for (const el of $('list').querySelectorAll('.row[data-i]')) {
    const m = rows[Number(el.dataset.i)];
    el.addEventListener('click', () => openMeeting(m.dir));
  }
}

function drawDetail(m) {
  if (!m) {
    $('detail').innerHTML = '<div class="dbody"><p class="empty">Select a meeting.</p></div>';
    return;
  }
  const body =
    dtab === 'notes'
      ? m.notes?.trim()
        ? `<div class="doc">${renderMarkdown(m.notes)}</div>`
        : '<p class="empty">You did not type anything during this meeting.</p>'
      : dtab === 'transcript'
        ? m.transcript
          ? `<div class="doc script">${renderTranscript(m.transcript)}</div>`
          : '<p class="empty">Not transcribed yet. Use <b>Transcribe &amp; copy prompt</b>.</p>'
        : m.note
          ? `<div class="doc">${renderMarkdown(m.note)}</div>`
          : `<p class="empty">No write-up saved yet.<br><br>
               Click <b>Transcribe &amp; copy prompt</b>, paste it into Claude or ChatGPT,
               then paste what comes back here and save.</p>
             <textarea id="pasteNote" placeholder="Paste the write-up here…"></textarea>
             <div class="dacts" style="padding:12px 0 0">
               <button id="saveNote" class="btn sm">Save write-up</button>
             </div>`;

  $('detail').innerHTML = `
    <div class="dhead">
      <h2>${esc(m.title)}</h2>
      <div class="sub">${fmtDate(m.startedAt)} · ${fmtDur(m.durationSeconds)} ·
        ${m.transcribed ? 'transcribed' : 'not transcribed'}${m.hasAudio ? ' · audio kept' : ''}</div>
    </div>
    <div class="dacts">
      <button id="dWrite" class="btn primary sm">${m.transcribed ? 'Write up with…' : 'Transcribe, then write up'}</button>
      <button id="dOpen" class="btn sm">Open folder</button>
      <button id="dDel" class="btn sm">Delete</button>
    </div>
    <div class="dtabs">
      <button data-t="notes" class="${dtab === 'notes' ? 'on' : ''}">My notes</button>
      <button data-t="transcript" class="${dtab === 'transcript' ? 'on' : ''}">Transcript</button>
      <button data-t="note" class="${dtab === 'note' ? 'on' : ''}">Write-up</button>
    </div>
    <div class="dbody">${body}</div>`;

  for (const b of $('detail').querySelectorAll('.dtabs button')) {
    b.addEventListener('click', () => { dtab = b.dataset.t; drawDetail(m); });
  }
  $('dWrite').addEventListener('click', (e) => writeUp(m.dir, e.target));
  $('dOpen').addEventListener('click', () => window.api.openFolder(m.dir).catch((err) => setStatus('Could not open the folder: ' + err.message, 'warn')));
  $('dDel').addEventListener('click', async () => {
    if (!confirm(`Move "${m.title}" to the recycle bin?`)) return;
    try {
      await window.api.deleteMeeting(m.dir);
      setStatus('Moved to the recycle bin.');
    } catch (e) {
      // Most often the folder is already gone, so refresh regardless or a
      // phantom row stays in the list.
      setStatus('Could not delete: ' + e.message, 'warn');
    }
    current = null;
    await refresh();
    drawDetail(null);
  });
  $('saveNote')?.addEventListener('click', async () => {
    const text = $('pasteNote').value;
    try {
      const r = await window.api.saveNote(m.dir, text);
      setStatus(`✓ Write-up saved (${r.chars.toLocaleString()} chars).`, 'good');
      await refresh();
      await openMeeting(m.dir);
    } catch (e) { setStatus(e.message, 'warn'); }
  });
}

async function openMeeting(dir) {
  current = dir;
  const m = await window.api.readMeeting(dir);
  renderList();
  drawDetail(m);
}

async function refresh() {
  meetings = await window.api.listMeetings();
  renderList();
}

let searchTimer = null;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('q').value.trim();
    if (!q) { lastHits = null; lastQuery = ''; return renderList(); }

    const hits = await window.api.search(q);
    // The box may have moved on while this was in flight; applying a stale
    // response would filter the list by a query the user has already cleared.
    if ($('q').value.trim() !== q) return;

    const snippets = {};
    for (const h of hits) {
      const best = [h.notesHit, h.noteHit, h.transcriptHit].find((x) => x && x.includes('\u0001'));
      if (best) {
        snippets[h.dir] = esc(best)
          .replaceAll('\u0001', '<b>')
          .replaceAll('\u0002', '</b>');
      }
    }
    lastQuery = q;
    lastHits = { order: new Map(hits.map((h, i) => [h.dir, i])), snippets };
    renderList();
    setStatus(`${hits.length} meeting(s) match "${q}".`);
  }, 200);
});
$('clearQ').addEventListener('click', () => {
  $('q').value = '';
  lastHits = null; lastQuery = '';
  renderList();
});

/* ═════════════════════════════════ tabs ══════════════════════════════════ */

function showView(which) {
  const rec = which === 'rec';
  $('viewRec').classList.toggle('hide', !rec);
  $('viewLib').classList.toggle('hide', rec);
  $('tabRec').classList.toggle('on', rec);
  $('tabLib').classList.toggle('on', !rec);
  if (!rec) refresh();
}
$('tabRec').addEventListener('click', () => showView('rec'));
$('tabLib').addEventListener('click', () => showView('lib'));

window.api.meetingsDir().then((d) => setStatus(`Ready. Saving to ${d}`));
