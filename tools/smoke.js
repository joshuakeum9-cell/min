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
 *   node tools/smoke.js              dev app, Electron from node_modules
 *   node tools/smoke.js --packaged   dist/win-unpacked/MIN-Notes.exe
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
const PACKAGED = process.argv.includes('--packaged');
const ALIVE_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures++;
  return ok;
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

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

/* --------------------------------------------------------------------- run */

const exe = PACKAGED ? path.join(ROOT, 'dist', 'win-unpacked', 'MIN-Notes.exe') : devBinary();
if (!fs.existsSync(exe)) {
  console.log(`FAIL  binary is missing  [${exe}]${PACKAGED ? '. Run npm run pack first.' : ''}`);
  process.exit(1);
}
console.log(`smoke: ${PACKAGED ? 'packaged' : 'dev'}  ${exe}`);
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
    const look = () => { const m = err.match(/ws:\/\/\S+/); if (m) { clearTimeout(t); res(m[0]); } };
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
  check(exceptions.length === 0 && csp.length === 0, 'no uncaught exception and no CSP violation',
    `${exceptions.length} exceptions, ${csp.length} CSP`);
  for (const e of exceptions.slice(0, 5)) console.log(`      exception: ${String(e).split('\n')[0]}`);
  for (const c of csp.slice(0, 5)) console.log(`      csp: ${c.text}`);
  const other = logs.filter((l) => l.level === 'error' && !csp.includes(l));
  if (other.length) console.log(`      note: ${other.length} other console errors, not fatal`);

  /* 6 */ check(dom.rail === 'ok' && dom.agenda === 'ok' && dom.ask === 'ok', 'rail, Coming up agenda and ask bar are present',
    `rail ${dom.rail}, comingUp ${dom.agenda}, askBar ${dom.ask}`);

  /* 7 */ let version = '';
  try { version = String(await evaluate('window.api.appVersion()', true) ?? ''); } catch { /* bridge is dead */ }
  check(Boolean(version), 'app version reported by the running app', version || 'unavailable');
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
