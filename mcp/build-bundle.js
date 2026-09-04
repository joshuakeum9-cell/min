/**
 * Builds taonim.mcpb — a one-click Claude Desktop extension.
 *
 * An .mcpb is a zip holding an MCP server plus a manifest, installed by
 * double-clicking it or dragging it onto Claude Desktop. That matters here
 * because the alternative is asking a non-technical user to hand-edit a JSON
 * config file, which is not a feature anyone would actually use.
 *
 * Claude Desktop ships its own Node runtime on macOS and Windows, so the bundle
 * needs nothing installed on the user's machine — not even Node.
 *
 * Run: npm run mcpb
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STAGE = path.join(ROOT, 'dist', 'mcpb-stage');
const OUT = path.join(ROOT, 'dist', 'taonim.mcpb');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Packages the server imports directly. Their transitive deps are resolved by npm. */
const RUNTIME_DEPS = ['@modelcontextprotocol/sdk', 'zod'];

const manifest = {
  manifest_version: '0.3',
  name: 'Taonim',
  display_name: 'Taonim meetings',
  version: pkg.version,
  description: 'Read and write up your local meeting notes.',
  long_description:
    'Gives Claude direct access to the meetings recorded by Taonim: the notes you ' +
    'typed during each call, the transcript with speakers separated into you and them, and ' +
    'the finished write-up.\n\n' +
    'Ask for "a write-up of my 3pm call" and Claude reads the meeting off your disk and ' +
    'saves the result straight back into its folder — no copying, no pasting, no API key.\n\n' +
    'Everything stays on your machine. The extension only reads and writes files inside your ' +
    'Meetings folder, and makes no network requests of its own.',
  author: { name: pkg.author ?? 'Joshua Keum' },
  license: pkg.license ?? 'MIT',
  keywords: ['meetings', 'notes', 'transcription', 'local-first'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
    },
  },
  tools: [
    { name: 'list_meetings', description: 'List recorded meetings, newest first' },
    { name: 'read_meeting', description: 'Read one meeting: your notes, the transcript, any write-up' },
    { name: 'search_meetings', description: 'Full-text search across every meeting' },
    { name: 'save_writeup', description: 'Save a finished write-up into the meeting folder' },
    { name: 'writing_guidance', description: 'How the user wants meetings written up' },
  ],
  compatibility: { runtimes: { node: '>=20.0.0' } },
};

/** Copy a file, rewriting import paths so the bundle is self-contained and flat. */
async function copyRewritten(from, to, rewrites = []) {
  let src = await fsp.readFile(from, 'utf8');
  for (const [a, b] of rewrites) src = src.split(a).join(b);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, src);
}

async function main() {
  await fsp.rm(STAGE, { recursive: true, force: true });
  const serverDir = path.join(STAGE, 'server');
  await fsp.mkdir(serverDir, { recursive: true });

  await fsp.writeFile(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // server.js imports ../app/library.js; inside the bundle both sit in server/.
  await copyRewritten(path.join(HERE, 'server.js'), path.join(serverDir, 'index.js'), [
    ["from '../app/library.js'", "from './library.js'"],
  ]);
  await copyRewritten(path.join(ROOT, 'app', 'library.js'), path.join(serverDir, 'library.js'));

  // Resolve the real dependency closure with npm rather than hand-copying the
  // top-level packages. The SDK pulls in seventeen transitive dependencies, and a
  // bundle missing even one fails only after the user installs it, with a
  // module-not-found they cannot act on.
  const versions = {};
  for (const d of RUNTIME_DEPS) {
    const v = pkg.dependencies?.[d] ?? pkg.devDependencies?.[d];
    if (!v) throw new Error(`${d} is not declared in package.json. Run: npm install ${d}`);
    versions[d] = v;
  }

  await fsp.writeFile(
    path.join(serverDir, 'package.json'),
    JSON.stringify(
      { name: 'taonim-mcp', version: pkg.version, type: 'module', private: true, dependencies: versions },
      null,
      2
    ) + '\n'
  );

  console.log('  resolving dependencies...');
  // When run through `npm run mcpb`, npm exports the path to its own CLI script.
  // Invoking that with node avoids both the shell (whose unescaped argument
  // concatenation Node now deprecates) and the .cmd-resolution problem on Windows.
  const npmCli = process.env.npm_execpath;
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
  if (npmCli && npmCli.endsWith('.js')) {
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd: serverDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  } else {
    // Fallback for a direct `node mcp/build-bundle.js`. Every argument here is a
    // literal, so the shell has nothing user-controlled to mangle.
    execFileSync('npm', args, {
      cwd: serverDir,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: true,
    });
  }

  const installed = await fsp.readdir(path.join(serverDir, 'node_modules'));
  console.log(`  ${installed.length} packages bundled`);

  // Prove the staged server actually loads before shipping it. Without this a
  // missing dependency ships silently and only fails on the user's machine.
  console.log('  verifying the staged server starts...');
  execFileSync(process.execPath, [path.join(serverDir, 'index.js')], {
    timeout: 20000,
    input: '',            // stdin closes immediately, so the server exits cleanly
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  await fsp.rm(OUT, { force: true });

  // An .mcpb is a plain zip. Windows has no `zip`, and Compress-Archive refuses
  // any extension but .zip, so write one there and rename.
  if (process.platform === 'win32') {
    const zip = OUT.slice(0, -'.mcpb'.length) + '.zip';
    await fsp.rm(zip, { force: true });
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(STAGE, '*')}' -DestinationPath '${zip}' -Force`],
      { stdio: 'inherit' }
    );
    await fsp.rename(zip, OUT);
  } else {
    execFileSync('zip', ['-qr', OUT, '.'], { cwd: STAGE, stdio: 'inherit' });
  }

  const size = (await fsp.stat(OUT)).size;
  await fsp.rm(STAGE, { recursive: true, force: true });

  console.log(`\n  ${path.relative(ROOT, OUT)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Install: double-click it, or drag it onto the Claude Desktop window.\n`);
}

await main();
