/**
 * End to end smoke test. Answers one question with no human in the loop:
 * does the built application actually start and work.
 *
 * This exists because MIN has shipped two releases that could not launch at
 * all. Both times every unit test passed, because a unit test never starts
 * Electron: the main process came up, every child process died instantly, and
 * the only thing that caught it was someone double clicking the real binary.
 * So this file treats the app as a black box. It imports nothing from app/,
 * it drives the real entry point, and check 3 below counts child processes,
 * which is the exact signature of that bug.
 *
 *   node tools/smoke.js               dev app, Electron from node_modules
 *   node tools/smoke.js --packaged    dist/win-unpacked/MIN-Notes.exe
 *   node tools/smoke.js --exe <path>  any binary, such as the installed one
 *
 * A packaged run also reads the asar before launching it. That is here because
 * this harness has already passed against an asar that did not contain the files
 * it was supposed to be testing: the build was stale, the app started, and every
 * check below reported on the previous release.
 *
 * Approach chosen: spawn the real entry point with --remote-debugging-port=0,
 * read the DevTools endpoint Chromium prints on stderr, and drive it over the
 * Chrome DevTools Protocol with node's global WebSocket. No generated main
 * script, no dependency, nothing injected into the app.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The value after a flag, or null when the flag is absent. */
function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// --exe points at an arbitrary binary, usually the one the installer put on
// disk. It is a packaged build by definition, so it gets the packaged checks,
// but those look at that binary's own resources rather than at dist/.
const EXE = flag('--exe');
if (process.argv.includes('--exe') && EXE === null) {
  console.log('FAIL  --exe needs a path');
  process.exit(1);
}
const PACKAGED = EXE !== null || process.argv.includes('--packaged');
const ALIVE_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
  return ok;
}

// A check that could not be run at all, which is neither a pass nor a failure.
// It is counted by neither, so the summary still says only what was proved.
function skip(label, detail) {
  console.log(`SKIP  ${label}${detail ? `  [${detail}]` : ''}`);
}

/* ------------------------------------------------------------------ launch */

// Electron's launcher records its binary name here; dev and CI can disagree.
function devBinary() {
  const dir = path.join(ROOT, 'node_modules', 'electron');
  const name = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
  return path.join(dir, 'dist', name);
}

let child = null;
let exited = null;
let profile = null;

// Every exit path runs this: the checks below, a throw, and Ctrl+C. It is
// idempotent, so calling it in a finally and again on 'exit' is fine.
function cleanup() {
  if (child) {
    const pid = child.pid;
    child = null;
    try {
      // Chromium's children are not in the parent's job on Windows, so kill the
      // whole tree. Anything less leaves orphan renderers behind.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch { /* already gone */ }
  }
  if (profile) {
    const dir = profile;
    profile = null;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* locked */ }
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

/* ------------------------------------------------- process tree inspection */

// Child command lines, plus the real OS window title where the platform has one.
// Read from outside the process on purpose: asking the app to describe itself
// would not have caught a launch where the app was there and its children were not.
function probe(pid) {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-o', 'args=', '--ppid', String(pid)], { encoding: 'utf8' });
    return { children: (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean), title: '' };
  }
  const ps = "$ErrorActionPreference='SilentlyContinue';"
    + `$k = Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty CommandLine;`
    + `[pscustomobject]@{children=@($k); title=(Get-Process -Id ${pid}).MainWindowTitle} | ConvertTo-Json -Depth 3 -Compress`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  try {
    const o = JSON.parse(r.stdout);
    return { children: [].concat(o.children ?? []).filter(Boolean), title: o.title ?? '' };
  } catch { return { children: [], title: '' }; }
}

/* ----------------------------------------------- packaged build inspection */

/** Every file under dir, as slash separated paths relative to it. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * The asar header, read without a dependency.
 *
 * An asar opens with a Chromium pickle: four UInt32LE, the last of which is the
 * length of a JSON header string sitting at offset 16. That is the whole format
 * needed here, because everything asserted below is in the header rather than in
 * the packed bytes after it.
 */
function asarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const pickle = Buffer.alloc(16);
    if (fs.readSync(fd, pickle, 0, 16, 0) !== 16) throw new Error('too short to be an asar');
    const size = pickle.readUInt32LE(12);
    const json = Buffer.alloc(size);
    if (fs.readSync(fd, json, 0, size, 16) !== size) throw new Error('header string is truncated');
    return JSON.parse(json.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** Flatten the header's directory tree into path -> entry, files only. */
function asarEntries(node, prefix = '', out = new Map()) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) asarEntries(entry, p, out);
    else out.set(p, entry);
  }
  return out;
}

/**
 * Everything provable about a build before it is launched.
 *
 * Staleness first: mtimes are crude, but the failure they catch is the one that
 * actually happened here, and it silently invalidates every later check. Then
 * the manifest, because "the app started" says nothing about whether the files
 * under test were inside it.
 */
function inspectBuild(asar) {
  const app = path.join(ROOT, 'app');
  const rel = walk(app);
  const sources = [...rel.map((r) => path.join(app, r)), path.join(ROOT, 'package.json')];
  const asarTime = fs.statSync(asar).mtimeMs;
  const newer = sources.filter((f) => fs.statSync(f).mtimeMs > asarTime).sort();
  check(newer.length === 0, 'asar is at least as new as every source file',
    newer.length
      ? `${path.relative(ROOT, newer[0])} is newer (${newer.length} in all). Run npm run pack`
      : `${sources.length} source files checked`);

  let entries;
  try {
    entries = asarEntries(asarHeader(asar));
  } catch (e) {
    check(false, 'asar header is readable', e.message);
    return;
  }

  // The wanted list is computed from the source tree rather than written out
  // here, so a script added to app/ tomorrow is covered without anyone
  // remembering to come back and edit this file.
  const wanted = rel.filter((r) => /\.(js|cjs)$/.test(r) && !r.endsWith('.test.js'));
  const missing = wanted.filter((r) => !entries.has(`app/${r}`));
  check(missing.length === 0, 'every app/ script is in the asar',
    missing.length ? `${missing.length} missing, e.g. app/${missing[0]}` : `${wanted.length} scripts`);

  const tests = [...entries.keys()].filter((p) => p.endsWith('.test.js'));
  check(tests.length === 0, 'no test file was packaged',
    tests.length ? `${tests.length} packaged, e.g. ${tests[0]}` : 'none');

  const pages = ['app/index.html', 'app/indicator.html'];
  const noPage = pages.filter((p) => !entries.has(p));
  check(noPage.length === 0, 'index.html and indicator.html are in the asar',
    noPage.length ? `missing ${noPage.join(', ')}` : 'both present');

  // The workers are handed to the runtime as real paths on disk, so an
  // asarUnpack rule that quietly stops matching is a launch failure rather than
  // a slow path.
  const workers = ['app/asr-worker.js', 'app/asr-live-worker.js'];
  const packed = workers.filter((p) => entries.get(p)?.unpacked !== true);
  check(packed.length === 0, 'the ASR workers are marked unpacked',
    packed.length ? `${packed.join(', ')} not unpacked` : 'both unpacked');
}

/* ----------------------------------------------------- devtools protocol */

const pending = new Map();
const exceptions = [];
const logs = [];
let ws = null;
let nextId = 0;
let session = null;

function send(method, params = {}, sessionId = session) {
  return new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, 15_000);
  });
}

async function evaluate(expression, awaitPromise = false, sessionId = session) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

/**
 * The floating indicator's page target, or null.
 *
 * Targets rather than windows, on purpose. Main hides the nub whenever the note
 * window is in front, which is most of a smoke run, so an assertion about a
 * visible OS window would fail on a build where everything works. The page
 * exists for the whole recording either way.
 */
async function indicatorTarget() {
  const { targetInfos } = await send('Target.getTargets', {}, null);
  return targetInfos.find((t) => t.type === 'page' && (t.url ?? '').includes('indicator.html')) ?? null;
}

/** Poll until the nub's target is there or gone, whichever was asked for. */
async function waitForIndicator(present, ms = 3_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const t = await indicatorTarget();
    if (Boolean(t) === present || Date.now() > deadline) return t;
    await sleep(100);
  }
}

/* --------------------------------------------------------------------- run */

const exe = EXE
  ? path.resolve(EXE)
  : PACKAGED ? path.join(ROOT, 'dist', 'win-unpacked', 'MIN-Notes.exe') : devBinary();
if (!fs.existsSync(exe)) {
  console.log(`FAIL  binary is missing  [${exe}]${PACKAGED && !EXE ? '. Run npm run pack first.' : ''}`);
  process.exit(1);
}
console.log(`smoke: ${PACKAGED ? 'packaged' : 'dev'}  ${exe}`);

// Before anything is launched, because a stale or short asar makes every check
// after it a report on some other build.
if (PACKAGED) {
  const asar = path.join(path.dirname(exe), 'resources', 'app.asar');
  if (fs.existsSync(asar)) inspectBuild(asar);
  else if (EXE) {
    // An arbitrary binary may keep its resources somewhere this cannot guess,
    // and that is not the same thing as a broken build.
    skip('asar is at least as new as every source file', `no asar at ${asar}`);
    skip('asar contents match the source tree', `no asar at ${asar}`);
  } else {
    check(false, 'packaged build has an app.asar', asar);
  }
}

profile = fs.mkdtempSync(path.join(os.tmpdir(), 'min-smoke-'));

// A throwaway profile, so the run never touches real settings and never loses
// to the app's single instance lock when the owner has MIN open.
const args = [...(PACKAGED ? [] : [ROOT]), '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`];
const started = Date.now();
child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
const pid = child.pid;
let err = '';
let out = '';
child.stderr.on('data', (d) => { err += d; });
child.stdout.on('data', (d) => { out += d; });
child.on('exit', (code) => { exited = code; });

try {
  const wsUrl = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no DevTools endpoint after 20s')), 20_000);
    // Anchored on the whole line Chromium prints, not on any ws:// it can find.
    // stderr carries the app's own logging too, and the first URL in it is not
    // necessarily the browser endpoint. The trailing newline is required so a
    // chunk that splits mid-URL cannot be read as a complete one.
    const look = () => {
      const m = /^DevTools listening on (ws:\/\/\S+)\r?\n/m.exec(err);
      if (m) { clearTimeout(t); res(m[1]); }
    };
    child.stderr.on('data', look);
    child.on('exit', (c) => { clearTimeout(t); rej(new Error(`app exited during startup, code ${c}`)); });
    look();
  });

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket refused')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      return m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
    }
    if (m.method === 'Log.entryAdded') logs.push(m.params.entry);
  };

  // Attach as soon as the window's target appears. Log.enable replays entries
  // Chromium already buffered, so a CSP violation from the very first paint is
  // still reported even though this attaches a moment after load.
  for (let i = 0; i < 150 && !session; i++) {
    const { targetInfos } = await send('Target.getTargets', {}, null);
    const page = targetInfos.find((t) => t.type === 'page');
    if (page) ({ sessionId: session } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, null));
    else await sleep(100);
  }
  if (!session) throw new Error('no page target ever appeared');
  await send('Runtime.enable');
  await send('Log.enable');

  await sleep(Math.max(0, ALIVE_MS - (Date.now() - started)));

  /* 1 */ const alive = check(exited === null, `process still alive after ${ALIVE_MS / 1000}s`, `pid ${pid}`);
  if (!alive) throw new Error(`app exited with code ${exited}`);

  const tree = probe(pid);
  const dom = await evaluate(`(() => {
    const state = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'missing';
      const cs = getComputedStyle(el);
      if (el.hidden || el.classList.contains('hide') || cs.display === 'none' || cs.visibility === 'hidden') return 'hidden';
      return 'ok';
    };
    return { title: document.title, home: state('viewHome'), rail: state('rail'), agenda: state('comingUp'), ask: state('askBar') };
  })()`);

  /* 2 */ const title = tree.title || dom.title;
  check(Boolean(title && title.trim()), 'window has a non-empty title', title || 'empty');

  /* 3 */ const renderers = tree.children.filter((c) => /--type=renderer/.test(c)).length;
  const gpus = tree.children.filter((c) => /--type=gpu-process/.test(c)).length;
  check(renderers > 0 && gpus > 0, 'child processes are alive (renderer and GPU)',
    `${tree.children.length} children, ${renderers} renderer, ${gpus} gpu`);

  /* 4 */ check(dom.home === 'ok', 'renderer reached the home view', `#viewHome ${dom.home}`);

  /* 5 */ const csp = logs.filter((l) => /content security policy/i.test(l.text ?? ''));
  // A module that fails to parse or a script that 404s is reported here and
  // never reaches Runtime.exceptionThrown, so a run that only counted thrown
  // exceptions passed with a dead renderer. These are page errors: they count.
  const pageErrors = logs.filter((l) => l.source === 'javascript' && l.level === 'error' && !csp.includes(l));
  check(exceptions.length === 0 && pageErrors.length === 0 && csp.length === 0,
    'no uncaught exception and no CSP violation',
    `${exceptions.length} exceptions, ${pageErrors.length} page errors, ${csp.length} CSP`);
  for (const e of exceptions.slice(0, 5)) console.log(`      exception: ${String(e).split('\n')[0]}`);
  for (const p of pageErrors.slice(0, 5)) console.log(`      page error: ${String(p.text ?? '').split('\n')[0]}`);
  for (const c of csp.slice(0, 5)) console.log(`      csp: ${c.text}`);
  // Whatever is left is network and security noise the page itself survived.
  const other = logs.filter((l) => l.level === 'error' && !csp.includes(l) && !pageErrors.includes(l));
  if (other.length) console.log(`      note: ${other.length} other console errors, not fatal`);

  /* 6 */ check(dom.rail === 'ok' && dom.agenda === 'ok' && dom.ask === 'ok', 'rail, Coming up agenda and ask bar are present',
    `rail ${dom.rail}, comingUp ${dom.agenda}, askBar ${dom.ask}`);

  /* 7 */ let version = '';
  try { version = String(await evaluate('window.api.appVersion()', true) ?? ''); } catch { /* bridge is dead */ }
  check(Boolean(version), 'app version reported by the running app', version || 'unavailable');

  /*
   * The floating indicator, driven the way the note view drives it: one IPC
   * push turns it on, another turns it off, and its whole lifetime hangs off
   * that signal. Everything below asserts on the page target and its DOM,
   * never on whether an OS window is on screen, because main deliberately
   * hides the nub while the note window is focused, which it is here.
   */
  // Caught rather than thrown. A build old enough to have no recordingState on
  // its bridge is exactly what --exe is pointed at, and one missing method
  // should fail this check and let the rest of the run report, not abort it and
  // throw away every result after it.
  let drove = true;
  try {
    await evaluate(`window.api.recordingState({ recording: true, you: 0.5, them: 0.4, title: 'smoke' })`);
  } catch (e) {
    drove = false;
    check(false, 'the bridge exposes recordingState', e.message.split(String.fromCharCode(10))[0]);
  }
  const nub = drove ? await waitForIndicator(true) : null;

  /* 8 */ if (check(Boolean(nub), 'floating indicator appears while recording',
    nub ? nub.url.split('/').pop() : 'no indicator.html target after 3s')) {
    const { sessionId: nubSession } = await send('Target.attachToTarget', { targetId: nub.targetId, flatten: true }, null);

    // The page is created and loaded asynchronously and the rec class only
    // lands once main pushes state after did-finish-load, so this waits for
    // the state rather than racing the load.
    const deadline = Date.now() + 3_000;
    let nubState = { rec: false, moveTo: 'undefined' };
    for (;;) {
      try {
        nubState = await evaluate(`({
          rec: Boolean(document.body && document.body.classList.contains('rec')),
          moveTo: typeof window.indicator?.moveTo,
        })`, false, nubSession);
      } catch { /* no execution context yet, the page is still loading */ }
      if (nubState.rec || Date.now() > deadline) break;
      await sleep(100);
    }

    /* 9 */ check(nubState.rec === true, 'indicator is drawing its recording state', `body.rec ${nubState.rec}`);
    /* 10 */ check(nubState.moveTo === 'function', 'indicator bridge exposes moveTo', `typeof ${nubState.moveTo}`);
  }

  if (drove) await evaluate(`window.api.recordingState({ recording: false, you: 0, them: 0, title: 'smoke' })`);
  /* 11 */ const stillThere = await waitForIndicator(false);
  check(stillThere === null, 'floating indicator is gone once recording stops',
    stillThere ? 'indicator.html target survived the stop' : 'target destroyed');
} catch (e) {
  check(false, 'harness completed', e.message);
  const tail = (s) => s.split('\n').filter(Boolean).slice(-8).join('\n      ');
  if (err.trim()) console.log(`      stderr:\n      ${tail(err)}`);
  if (out.trim()) console.log(`      stdout:\n      ${tail(out)}`);
} finally {
  try { ws?.close(); } catch { /* never opened */ }
  cleanup();
}

console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
