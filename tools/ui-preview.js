/**
 * Serves app/index.html so the interface can be inspected in a browser during
 * design work. Development only — the real app loads the same file through
 * Electron, where window.api exists.
 *
 * The renderer expects window.api (an Electron preload bridge). Here that is
 * absent, so a small stub is injected: enough for the layout and every view to
 * render with plausible content, and nothing that touches disk.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4173;

const STUB = `
<script>
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
      note: '# Timeline\\n\\nThe pilot is moving to the second week of October — the data team is not ready. That compresses the review window to four days, which works only if the schema is frozen by Friday.\\n\\n# Risks\\n\\nThe vendor may slip again. The fallback is one more manual export cycle, which nobody wants to run in December.\\n\\n# Mine\\n\\nOpen the legal ticket this afternoon. The DPA takes ten working days.',
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
</script>
`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/app/index.html') || req.url === '/' || req.url.startsWith('/?')) {
      let html = await fs.readFile(path.join(ROOT, 'app', 'index.html'), 'utf8');
      html = html.replace('<script type="module">', STUB + '<script type="module">');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    // The renderer imports ./md.js as a module; serve anything under app/.
    if (/^\/app\/[\w.-]+\.js$/.test(req.url)) {
      const js = await fs.readFile(path.join(ROOT, req.url.replace(/^\//, '')), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(js);
    }
    if (/^\/[\w.-]+\.js$/.test(req.url)) {
      const js = await fs.readFile(path.join(ROOT, 'app', req.url.replace(/^\//, '')), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(js);
    }
    // The landing page, served raw (no window.api stub needed).
    if (req.url.startsWith('/site')) {
      const rel = req.url === '/site' || req.url === '/site/' ? 'site/index.html' : req.url.slice(1);
      const file = path.join(ROOT, rel);
      const html = await fs.readFile(file);
      const type = file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type });
      return res.end(html);
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    res.writeHead(500).end(String(err.message));
  }
});

server.listen(PORT, () => console.log(`ui preview on http://localhost:${PORT}`));
