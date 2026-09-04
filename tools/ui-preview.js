/**
 * Serves app/index.html so the interface can be inspected in a browser during
 * design work. Development only, the real app loads the same file through
 * Electron, where window.api exists.
 *
 * The renderer expects window.api (an Electron preload bridge). Here that is
 * absent, so a small stub is served at /__api-stub.js: enough for the layout
 * and every view to
 * render with plausible content, and nothing that touches disk.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const DOCS = path.join(ROOT, 'docs');
const PORT = 4173;
const HOST = '127.0.0.1'; // loopback only: this serves files off the developer's disk.

// Windows compares paths case-insensitively, so the containment test must too.
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * The path part of a request URL, percent-decoded. Null when the escape
 * sequences are malformed or the path carries a NUL byte, both of which only
 * ever show up in an attempt to confuse the path handling below.
 */
function pathnameOf(url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  return decoded.includes('\0') ? null : decoded;
}

/**
 * Resolve `relative` under `base`, or null if it escapes. req.url is whatever
 * the client sent, so a request for docs/../../../.ssh/id_rsa must resolve to
 * nothing rather than to a file. Compares against base plus a trailing
 * separator so a sibling like docs-private cannot pass as a child of docs.
 */
function resolveInside(base, relative) {
  const full = path.resolve(base, relative);
  const guard = base.endsWith(path.sep) ? base : base + path.sep;
  if (fold(full) !== fold(base) && !fold(full).startsWith(fold(guard))) return null;
  return full;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const STUB_JS = `
  const iso = (d) => new Date(d).toISOString();
  const FAKE = [
    { id:'2026-09-03-1400-vendor-sync', dir:'/m/1', title:'Vendor sync', startedAt: iso('2026-09-03T14:00'),
      durationSeconds: 2760, transcribed:true, written:true, hasAudio:false },
    { id:'2026-09-03-1030-hiring-loop', dir:'/m/2', title:'Hiring loop review', startedAt: iso('2026-09-03T10:30'),
      durationSeconds: 1920, transcribed:true, written:false, hasAudio:true },
    { id:'2026-09-02-1615-infra-costs', dir:'/m/3', title:'Infra costs', startedAt: iso('2026-09-02T16:15'),
      durationSeconds: 1500, transcribed:false, written:false, hasAudio:true },
  ];
  const BODY = {
    '/m/1': {
      notes: '# Timeline\\n- pilot slipping?\\n- schema freeze friday\\n\\n# Risks\\n- vendor again\\n- legal DPA lead time\\n\\n# Mine\\n- open the ticket',
      transcript: '[00:00:00] Them: We should push the pilot to the second week of October.\\n[00:00:17] You: That works, but it compresses the review window to four days.\\n[00:00:34] Them: Four days is enough if we get the schema frozen by Friday.',
      note: '# Timeline\\n\\nThe pilot is moving to the second week of October, the data team is not ready. That compresses the review window to four days, which works only if the schema is frozen by Friday.\\n\\n# Risks\\n\\nThe vendor may slip again. The fallback is one more manual export cycle, which nobody wants to run in December.\\n\\n# Mine\\n\\nOpen the legal ticket this afternoon. The DPA takes ten working days.',
    },
  };
  window.api = {
    meetingsDir: async () => 'C:\\\\Users\\\\You\\\\Meetings',
    setAlwaysOnTop: async () => true,
    listMeetings: async () => FAKE,
    readMeeting: async (dir) => {
      const m = FAKE.find((x) => x.dir === dir) ?? FAKE[0];
      const b = BODY[dir] ?? { notes:'(no notes typed)', transcript:null, note:null };
      return { ...m, ...b };
    },
    search: async () => [],
    saveNote: async () => ({ chars: 0 }),
    deleteMeeting: async () => true,
    transcribe: async () => ({ count: 0, ok: true, echoes: 0 }),
    copyPrompt: async () => ({ words: 3200 }),
    openProvider: async () => {},
    openFolder: async () => {},
    modelsReady: async () => true,
  };
`;

const server = http.createServer(async (req, res) => {
  try {
    const url = pathnameOf(req.url);
    if (url === null) return res.writeHead(400).end('bad request');

    if (url === '/app/index.html' || url === '/') {
      let html = await fs.readFile(path.join(APP, 'index.html'), 'utf8');
      // A classic script runs at parse time, so the stub is in place before
      // renderer.js, which is deferred by virtue of being a module.
      html = html.replace('<script type="module"', '<script src="/__api-stub.js"></script><script type="module"');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(html);
    }
    if (url === '/__api-stub.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(STUB_JS);
    }
    // The renderer imports ./md.js as a module; serve anything under app/, by
    // either the /app/ path or the bare filename the module specifier produces.
    const js = /^\/(?:app\/)?([\w.-]+\.js)$/.exec(url);
    if (js) {
      const file = resolveInside(APP, js[1]);
      if (!file) return res.writeHead(403).end('forbidden');
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(await fs.readFile(file, 'utf8'));
    }
    // Vendored fonts, so the preview shows the real typefaces rather than a
    // fallback. The app loads these from disk; here they need a route.
    if (url.startsWith('/app/')) {
      const file = resolveInside(APP, url.slice('/app/'.length));
      if (!file) return res.writeHead(403).end('forbidden');
      const body = await fs.readFile(file).catch(() => null);
      if (!body) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      return res.end(body);
    }
    // The landing page, served raw (no window.api stub needed).
    if (url === '/docs' || url.startsWith('/docs/')) {
      const rel = url.slice('/docs'.length).replace(/^\/+/, '') || 'index.html';
      const file = resolveInside(DOCS, rel);
      if (!file) return res.writeHead(403).end('forbidden');
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      return res.end(body);
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    // A miss inside a served folder is a 404; anything else is a real fault,
    // reported without the message so paths off disk stay off the wire.
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EPERM') {
      return res.writeHead(404).end('not found');
    }
    console.error(err);
    res.writeHead(500).end('server error');
  }
});

server.listen(PORT, HOST, () => console.log(`ui preview on http://${HOST}:${PORT}`));
