/**
 * MIN, live transcription: the main-process side.
 *
 * Owns one asr-live-worker.js child for the length of a recording. Spawns it,
 * streams PCM frames to it with backpressure, turns its JSON lines into
 * callbacks, and on stop() hands back every segment it produced, in order, so
 * the caller writes transcript.md from that list. The list IS the transcript.
 * There is no second pass over the audio, because the user has already watched
 * every line of it scroll past and should not wait five minutes for it again.
 *
 * No Electron imports. The same module runs under plain node, which is how
 * live.test.js drives it.
 *
 *   const live = createLiveSession({ onSegment, onReady, onError });
 *   live.push('you', int16);         // 16 kHz mono, as often as the worklet ticks
 *   live.push('them', int16);
 *   const { segments, ok, complete } = await live.stop();
 *
 * Create the session before capture starts if you can: the worker takes ~3 s
 * to load Parakeet, and frames pushed in the meantime simply queue.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureModel, llmPath, modelReady, MANIFEST, MODELS_DIR, totalBytes } from '../m0/lib/models.js';
import { stripFillers as removeFillers } from './fillers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Inside a packaged app this file lives in app.asar, but the worker is spawned by
// real path, so it must point at the unpacked copy. Electron rewrites asar paths
// for fs calls automatically; it does not for spawn arguments.
const WORKER = path
  .join(HERE, 'asr-live-worker.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const TRACKS = ['you', 'them'];
const TRACK_ID = { you: 0, them: 1 };
const EMPTY = new Int16Array(0);

// Lives in its own import-free module so main.js can use it at load time
// without pulling this file, and the models directory it reads, in early.
// Re-exported so the tests and any caller keep one name for it.
export { samplesFromIpc } from './ipc-samples.js';

const envWithout = (env, drop) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !drop.includes(k)));

// The app's before-quit hook only knows about transcribe.js's workers, and a
// live worker holds the same 650 MB model, so this module cleans up its own.
const sessions = new Set();
export function killLiveSessions() {
  for (const s of sessions) s.kill();
  sessions.clear();
}
process.once('exit', killLiveSessions);

/* ------------------------------------------------------------------ models */

const fileSize = (f) => fsp.stat(f).then((s) => s.size).catch(() => null);

/**
 * ensureModel() downloads with a console progress bar and no callback. For a
 * first run inside the app that is invisible, so while it works this polls the
 * sizes of the files it is writing (the .part is the download in flight, the
 * bare name means finished) and reports bytes against the manifest total.
 */
async function ensureWithProgress(name, onProgress) {
  if (!onProgress || (await modelReady(name))) return ensureModel(name);

  const spec = MANIFEST[name];
  const total = totalBytes(name);
  const files =
    spec.kind === 'file' || spec.kind === 'llm'
      ? [path.join(MODELS_DIR, spec.file)]
      : Object.keys(spec.files).map((rel) => path.join(MODELS_DIR, spec.dir, rel));

  const tick = async () => {
    let received = 0;
    for (const f of files) received += (await fileSize(f)) ?? (await fileSize(`${f}.part`)) ?? 0;
    onProgress({ phase: 'download', model: name, received, total });
  };
  const timer = setInterval(tick, 500);
  try {
    await tick();
    return await ensureModel(name);
  } finally {
    clearInterval(timer);
  }
}

/* ------------------------------------------------------------------- frame */

/**
 * One stdin frame: u8 track, u32le sample count, int16le samples. Int16Array
 * is what the protocol carries; Float32Array is accepted too because that is
 * what the renderer's worklet produces, and clamped because system audio has
 * been measured over full scale.
 */
function frame(track, samples) {
  const n = samples.length;
  const buf = Buffer.allocUnsafe(5 + n * 2);
  buf[0] = TRACK_ID[track];
  buf.writeUInt32LE(n, 1);
  if (samples instanceof Int16Array) {
    // Every platform Electron ships on is little-endian, so the bytes go as they are.
    Buffer.from(samples.buffer, samples.byteOffset, n * 2).copy(buf, 5);
  } else {
    for (let i = 0, o = 5; i < n; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      buf.writeInt16LE(Math.round(s * 32767), o);
    }
  }
  return buf;
}

/* ----------------------------------------------------------------- session */

/**
 * @param {object} opts
 * @param {string}  [opts.modelDir]   Parakeet dir; resolved via ensureModel() when omitted
 * @param {string}  [opts.vadModel]   silero_vad_v5.onnx; resolved the same way
 * @param {string}  [opts.asrModel]   'parakeet-v3' (default) or 'parakeet-v2'
 * @param {number}  [opts.threads]    recogniser threads, default 4 like the batch path
 * @param {function} [opts.onSegment]  ({track,t0,t1,text,rms,echo,echoOf?}) as each utterance lands
 * @param {function} [opts.onEcho]     (segment) an already-delivered segment is now flagged echo
 * @param {function} [opts.onReady]    ({ms, restart}) models resident
 * @param {function} [opts.onProgress] ({phase:'download',model,received,total} | {phase:'load'})
 * @param {function} [opts.onError]    (Error) err.recoverable is true when the worker was restarted
 * @param {function} [opts.onLog]      (line) worker stderr, for a debug console
 * @param {number}  [opts.stopTimeoutMs]  how long stop() waits for the last segments, default 60 s
 * @param {number}  [opts.readyTimeoutMs] how long to wait for the model load, default 120 s
 * @param {number}  [opts.maxRestarts]    respawns allowed after a mid-recording crash, default 2
 * @param {number}  [opts.maxCleanExits]  respawns allowed after a clean early finish, default 6
 * @param {boolean} [opts.stripFillers]   drop standalone uh/um/hm from each line, default false
 * @param {number}  [opts.startOffsetSamples] where this capture sits on the meeting clock,
 *                                        in samples at 16 kHz. Non-zero when resuming.
 */
export function createLiveSession(opts = {}) {
  const {
    modelDir: givenModelDir,
    vadModel: givenVadModel,
    asrModel = 'parakeet-v3',
    threads = 4,
    onSegment,
    onEcho,
    onReady,
    onProgress,
    onError,
    onLog,
    stopTimeoutMs = 60_000,
    readyTimeoutMs = 120_000,
    maxRestarts = 2,
    // Higher than maxRestarts on purpose: a clean early finish costs nothing but
    // a model reload, where a crash suggests something genuinely wrong.
    maxCleanExits = 6,
    stripFillers = false,
    startOffsetSamples = 0,
  } = opts;

  const segments = [];
  const queue = []; // { buf, track, n, resolve }, frames not yet written to a worker
  /*
   * Samples handed to a worker so far. The worker is told this on spawn and
   * dates every segment from it, so a respawned worker keeps its t0/t1 on the
   * recording's timeline rather than restarting at zero.
   *
   * Seeded rather than started at zero, so a Resume puts its lines where they
   * belong on the MEETING's clock rather than at the start of its own segment.
   * The crash path inherits it for free: a respawn reads this same counter.
   */
  const seed = Number.isFinite(startOffsetSamples) && startOffsetSamples > 0
    ? Math.round(startOffsetSamples)
    : 0;
  const written = { you: seed, them: seed };

  let models = null;
  let child = null;
  let ready = false;
  let draining = false;
  let restarts = 0;
  let workerDone = false;
  // Clean finishes have their own budget. A worker that said 'done' did not
  // crash, so it must not spend the crash allowance or be reported as one.
  let cleanExits = 0;
  let lastStdinError = null;
  let workerError = null;
  let stopping = null; // the promise stop() returns
  let stopPending = false; // flush frames are queued or sent
  let killed = false;
  let dead = false; // no worker and none coming
  let fatal = null;
  let stderrTail = '';
  let readyTimer = null;

  // segments() is read-only and a copy: main.js rewrites transcript.md from
  // it every couple of seconds while the meeting runs, so that anything reading
  // the folder, the MCP server above all, sees the conversation so far.
  const session = { push, stop, kill, segments: () => segments.slice() };
  sessions.add(session);

  /* ................................................................ worker */

  function spawnWorker() {
    // In a packaged app process.execPath is the Electron binary, not node, so a
    // bare spawn would launch a second copy of the app instead of the worker.
    // ELECTRON_RUN_AS_NODE makes that same binary behave as plain Node. Harmless
    // under `node`, which ignores it.
    const c = spawn(
      process.execPath,
      [WORKER, models.modelDir, models.vadModel, String(threads), String(written.you), String(written.them)],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // ELECTRON_RUN_AS_NODE makes this binary honour NODE_OPTIONS, so an
        // inherited --require would run attacker code inside the worker.
        // The worker needs none of these.
        env: { ...envWithout(process.env, ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']), ELECTRON_RUN_AS_NODE: '1' },
      }
    );
    child = c;
    ready = false;
    draining = false;
    workerDone = false;
    stderrTail = '';

    /*
      * This used to be swallowed entirely, on the reasoning that EPIPE after a
      * crash is reported by the close handler anyway. But a write failure here
      * is also a CAUSE, not only a symptom: the worker sees its stdin end and
      * flushes both tracks, which finishes it cleanly mid-recording. Keeping
      * the message is what makes that visible afterwards.
      */
    c.stdin.on('error', (err) => {
      lastStdinError = err?.message ?? String(err);
      onLog?.(`[live] stdin write failed: ${lastStdinError}`);
    });

    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      if (child !== c || !line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // native libraries print to stdout too; ignore non-JSON
      }
      handleMessage(msg);
    });

    c.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      if (onLog) for (const l of s.split(/\r?\n/)) if (l.trim()) onLog(l);
    });

    c.on('error', (err) => {
      if (child !== c) return;
      child = null;
      fail(new Error(`could not start the live worker: ${err.message}`));
    });
    c.on('close', (code, signal) => {
      if (child !== c) return;
      child = null;
      handleClose(code, signal);
    });

    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (child !== c || ready) return;
      fail(new Error(`live worker did not load its models within ${readyTimeoutMs / 1000} s`));
      c.kill();
    }, readyTimeoutMs);
    readyTimer.unref?.();

    pump();
  }

  function handleMessage(msg) {
    if (msg.type === 'segment') {
      /*
       * Fillers come off here rather than in the worker. The worker is
       * asar-unpacked, so a module it imports has to be unpacked with it, and
       * getting that wrong ships a build that works in development and fails
       * once installed. This is also the single boundary every line crosses, so
       * the bubbles on screen and the transcript on disk can never disagree.
       */
      const text = stripFillers ? removeFillers(msg.text) : msg.text;
      // An utterance that was nothing but a hesitation is not an utterance. A
      // bubble reading "" would be a speaker turn that never happened.
      if (!text) return;
      const seg = { track: msg.track, t0: msg.t0, t1: msg.t1, text, rms: msg.rms, echo: !!msg.echo };
      if (msg.echo) seg.echoOf = msg.echoOf;
      segments.push(seg);
      onSegment?.(seg);
    } else if (msg.type === 'echo') {
      const seg = segments.find((s) => s.track === msg.track && s.t0 === msg.t0 && s.t1 === msg.t1);
      if (!seg || seg.echo) return;
      seg.echo = true;
      seg.echoOf = msg.echoOf;
      onEcho?.(seg);
    } else if (msg.type === 'ready') {
      ready = true;
      clearTimeout(readyTimer);
      onReady?.({ ms: msg.ms, restart: restarts });
    } else if (msg.type === 'progress') {
      onProgress?.({ phase: 'load' });
    } else if (msg.type === 'done') {
      workerDone = true;
    } else if (msg.type === 'error') {
      workerError = msg.message;
    }
  }

  function handleClose(code, signal) {
    clearTimeout(readyTimer);
    const how = signal ? `signal ${signal}` : `exit code ${code}`;
    if (killed || stopPending) {
      if (!workerDone && !killed && !fatal) {
        fatal = new Error(`live worker died while finishing (${how}); the last lines may be missing`);
      }
      dead = true;
      return;
    }
    // Unexpected. A worker that never became ready is broken, not unlucky.
    if (!ready) {
      const hint = stderrTail.trim().split(/\r?\n/).pop() ?? '';
      fail(new Error(`live worker exited before it was ready (${how})${hint ? `: ${hint}` : ''}`));
      return;
    }

    /*
     * A worker that sent 'done' finished cleanly: it flushed both tracks and
     * left, and every segment it produced has already been delivered. That is
     * NOT a crash, and calling it one is what turned a survivable hiccup into
     * "giving up" after three tries.
     *
     * It happens mid-recording when the worker's stdin ends or errors, because
     * both of those flush both tracks. The cause is upstream of the worker, so
     * respawning is the right response, but quietly: nothing was lost except
     * the audio still inside the dead process, and the user does not need a red
     * message about a transcript that is still working.
     */
    if (workerDone) {
      if (cleanExits >= maxCleanExits) {
        fail(new Error(
          `live transcription kept finishing early (${how}, ${cleanExits} times)` +
          `${lastStdinError ? `, last pipe error: ${lastStdinError}` : ''}. ` +
          'The recording is unaffected and Write up will transcribe from the audio.'
        ));
        return;
      }
      cleanExits++;
      onLog?.(`[live] worker finished early (${how}); restarting quietly, clean exit ${cleanExits}`);
      spawnWorker();
      return;
    }

    if (restarts >= maxRestarts) {
      const hint = stderrTail.trim().split(/\r?\n/).pop() ?? '';
      fail(new Error(
        `live worker crashed (${how}) and has already been restarted ${restarts} times, giving up` +
        `${hint ? `: ${hint}` : ''}. The recording is unaffected and Write up will transcribe from the audio.`
      ));
      return;
    }
    // A native abort mid-meeting. Whatever was inside the dead worker (its open
    // utterance, frames in its pipe) is gone, a few seconds at most. The rest of
    // the meeting should not be.
    restarts++;
    const at = Math.max(written.you, written.them) / 16000;
    const err = new Error(
      `live worker crashed (${how}) around ${at.toFixed(0)}s and was restarted; a few seconds of speech there are lost`
    );
    err.recoverable = true;
    onError?.(err);
    spawnWorker();
  }

  function fail(err) {
    if (dead) return;
    dead = true;
    fatal = err;
    clearTimeout(readyTimer);
    for (const item of queue.splice(0)) item.resolve(false);
    onError?.(err);
  }

  /* ................................................................ frames */

  function pump() {
    if (!child || draining || dead) return;
    while (queue.length) {
      const item = queue.shift();
      const ok = child.stdin.write(item.buf);
      written[item.track] += item.n;
      item.resolve(true);
      if (!ok) {
        // Node would happily buffer a whole meeting in memory. Wait for the pipe.
        draining = true;
        child.stdin.once('drain', () => {
          draining = false;
          pump();
        });
        return;
      }
    }
  }

  function enqueue(track, samples) {
    return new Promise((resolve) => {
      queue.push({ buf: frame(track, samples), track, n: samples.length, resolve });
      pump();
    });
  }

  /**
   * Queue one frame of a track. Resolves true once the frame has been written
   * to the worker, false if the session is over and the frame was dropped.
   * Awaiting it throttles the caller to the worker's pace; not awaiting it is
   * fine too, the queue is what absorbs the ~3 s model load.
   */
  function push(track, samples) {
    if (!(track in TRACK_ID)) throw new TypeError(`track must be "you" or "them", got ${JSON.stringify(track)}`);
    if (!(samples instanceof Int16Array) && !(samples instanceof Float32Array)) {
      throw new TypeError('samples must be an Int16Array or Float32Array at 16 kHz mono');
    }
    if (stopping || dead) return Promise.resolve(false);
    // A zero-length frame is how stop() tells the worker a track has ended.
    // From a caller it can only be a mistake, and honouring it ends the
    // transcript mid-meeting, so it is dropped here rather than forwarded.
    if (samples.length === 0) return Promise.resolve(false);
    return enqueue(track, samples);
  }

  /* ................................................................ finish */

  /**
   * Flush both tracks, wait for the worker's final segments, and resolve with
   * everything it produced, ordered by start time. `complete` is the bit the
   * caller needs before deleting the audio: a clean finish with no restarts.
   */
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await booted;
      } catch {
        /* already reported through onError */
      }
      if (child && !dead) {
        stopPending = true;
        const c = child;
        const closed = new Promise((r) => c.once('close', r));
        await enqueue('you', EMPTY);
        await enqueue('them', EMPTY);
        c.stdin.end();
        const timer = setTimeout(() => {
          fatal ??= new Error(
            `live worker did not finish within ${stopTimeoutMs / 1000} s; the transcript may be missing its last lines`
          );
          c.kill();
        }, stopTimeoutMs);
        await closed;
        clearTimeout(timer);
      }
      dead = true;
      sessions.delete(session);
      segments.sort((a, b) => a.t0 - b.t0 || (a.track === 'you' ? -1 : 1));
      const error = fatal?.message ?? workerError ?? null;
      const ok = !error && workerDone;
      return {
        segments,
        ok,
        complete: isLiveComplete({ ok, restarts, cleanExits }),
        restarts,
        cleanExits,
        error,
      };
    })();
    return stopping;
  }

  /** The abort path. Nothing is flushed and nothing is returned. */
  function kill() {
    killed = true;
    dead = true;
    clearTimeout(readyTimer);
    child?.kill();
    for (const item of queue.splice(0)) item.resolve(false);
    sessions.delete(session);
  }

  /* .................................................................. boot */

  const booted = (async () => {
    const modelDir = givenModelDir ?? (await ensureWithProgress(asrModel, onProgress));
    let vadModel = givenVadModel;
    if (!vadModel) {
      await ensureWithProgress('silero-vad', onProgress);
      vadModel = llmPath('silero-vad');
    }
    if (dead) return;
    models = { modelDir, vadModel };
    onProgress?.({ phase: 'load' });
    spawnWorker();
  })().catch((err) => fail(err));

  return session;
}

/* -------------------------------------------------------------- transcript */

/**
 * Reshape a session's segments into what transcribe.js's buildTranscript()
 * expects, so transcript.md comes out byte-for-byte in the same format as the
 * batch path. Echoes are dropped here by default; buildTranscript runs the same
 * rule again over what is left, which is harmless and catches nothing new.
 */
/**
 * Whether a finished live session covers the whole recording, with nothing
 * missing in the middle of it.
 *
 * This is the flag the audio is deleted on (`main.js`, the `live-stop`
 * handler), so it has to mean "there is no hole here", not "the worker ended
 * tidily". Both respawn paths leave a hole and both have to count:
 *
 * - A crash loses the worker's open utterance and whatever frames were still
 *   in its pipe.
 * - A clean early finish is gentler, because the worker flushes both tracks on
 *   its way out and delivers what it had already decoded. But the replacement
 *   still takes a couple of seconds to load the model, and every frame spoken
 *   in that window is dropped.
 *
 * Pure and exported so the rule can be tested without spawning a worker. The
 * first version of the clean-exit fix counted only `restarts`, which left a
 * clean-exit respawn reporting `complete: true` and quietly authorised deleting
 * the only copy of the audio covering the gap it had just made.
 *
 * @param   {{ok?:boolean, restarts?:number, cleanExits?:number}} outcome
 * @returns {boolean}
 */
export function isLiveComplete({ ok = false, restarts = 0, cleanExits = 0 } = {}) {
  return ok === true && restarts === 0 && cleanExits === 0;
}

export function toTranscriptResults(segments, { dropEchoes = true } = {}) {
  return TRACKS.map((track) => {
    const speaker = track === 'you' ? 'You' : 'Them';
    return {
      speaker,
      ok: true,
      segments: segments
        .filter((s) => s.track === track && !(dropEchoes && s.echo))
        .map((s) => ({ speaker, start: s.t0, end: s.t1, text: s.text, rms: s.rms })),
    };
  });
}
