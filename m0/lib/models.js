/**
 * Model acquisition: resumable per-file download, size verification, sha256 pinning.
 *
 * Everything is fetched as individual files from HuggingFace rather than as
 * release tarballs. The tarballs work, but bzip2-decompressing 482 MB costs over
 * two minutes of pinned CPU, cannot resume, and needs a system `tar` that handles
 * bz2, which Windows' bundled bsdtar does not reliably do. Per-file downloads
 * resume, verify individually, and are what the shipping app should do anyway.
 *
 * Sizes were read from the HuggingFace API on 2026-09-02. Integrity comes from
 * models.pins.json, which ships inside the app next to this file and holds the
 * sha256 the release was built against. That is the authority: a download whose
 * hash does not match it is refused, and a key with no pin is refused too.
 * models.lock.json lives in the writable models directory and is only a
 * size+mtime cache, so a 652 MB encoder is not re-hashed before every
 * transcription. It grants nothing on its own, since a fresh install starts with
 * no lock file at all and an attacker-writable one must not be able to pin.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain } from './hardware.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Where model files live.
 *
 * In development that is ./models next to the source. In a packaged app the
 * source sits inside an asar archive, which is read-only, so the host sets
 * MIN_MODELS_DIR to a writable per-user location before importing this.
 * Models are never bundled into the installer: they are ~4.6 GB, carry their own
 * licences, and baking them in would make every auto-update re-download the lot.
 */
export const MODELS_DIR =
  process.env.MIN_MODELS_DIR || path.resolve(HERE, '../../models');
const LOCK_FILE = path.join(MODELS_DIR, 'models.lock.json');

/**
 * Shipped checksums, read from the source tree rather than from MODELS_DIR.
 * MODELS_DIR is a per-user directory that starts empty, so anything read from
 * there is written by whoever downloaded the models and cannot vouch for them.
 * build.files already ships the whole of m0/lib, so this file travels inside the
 * asar alongside the code it protects.
 */
const PINS = JSON.parse(fs.readFileSync(path.join(HERE, 'models.pins.json'), 'utf8'));

/**
 * Resolve against an immutable commit, never `main`.
 *
 * `main` is a moving ref. If upstream re-quantises a file, the manifest's byte
 * counts stop matching and every NEW install fails at first transcription with a
 * size mismatch, while existing installs keep working, because the size check
 * short-circuits before the download. That makes it invisible to the developer
 * and fatal for everyone else, which is exactly backwards for a project whose
 * point is that other people can install it.
 */
const hf = (repo, file, rev) =>
  `https://huggingface.co/${repo}/resolve/${rev ?? 'main'}/${file}`;

export const MANIFEST = {
  'parakeet-v2': {
    kind: 'asr',
    note: 'English only. The research default.',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    rev: '1ab9323565ddb038682214b292f588070a538ce2',  // pinned 2026-09-03
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    license: 'CC-BY-4.0 (NVIDIA), attribution required in a NOTICES screen',
    files: {
      'encoder.int8.onnx': 652184296,
      'decoder.int8.onnx': 7257753,
      'joiner.int8.onnx': 1739080,
      'tokens.txt': 9384,
      'test_wavs/0.wav': 237964,
    },
  },
  'parakeet-v3': {
    kind: 'asr',
    note: '25 languages. sherpa-onnx does publish this, the research concluded it did not, and that was wrong.',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    rev: '2bda32ec70b097a55adaa07d9a7173915b43cc78',  // pinned 2026-09-03
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    license: 'CC-BY-4.0 (NVIDIA), attribution required in a NOTICES screen',
    files: {
      'encoder.int8.onnx': 652184281,
      'decoder.int8.onnx': 11845275,
      'joiner.int8.onnx': 6355277,
      'tokens.txt': 93939,
      'test_wavs/en.wav': 184608,
      'test_wavs/de.wav': 121388,
      'test_wavs/es.wav': 235052,
      'test_wavs/fr.wav': 219180,
    },
  },
  'silero-vad': {
    kind: 'file',
    note: 'Voice activity detection. Skips silence before it ever reaches the recogniser.',
    // This is a GitHub release asset on a mutable tag, so unlike the HuggingFace
    // entries there is no revision to pin and the bytes behind this URL can be
    // replaced in place. Its entry in models.pins.json is the only thing that
    // makes that detectable.
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx',
    file: 'silero_vad_v5.onnx',
    bytes: 2313101,
    license: 'MIT (Silero Team)',
  },
  'qwen3-4b': {
    kind: 'llm',
    note: 'Standard tier, >=12 GB RAM. Picked on hallucination rate, not release date.',
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    rev: 'a06e946bb6b655725eafa393f4a9745d460374c9',  // pinned 2026-09-03
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    bytes: 2497281120,
    license: 'Apache-2.0',
  },
  'qwen3-1.7b': {
    kind: 'llm',
    note: 'Light tier, 8 GB RAM.',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    rev: 'd7f544eead698dbd1f15126ef60b45a1e1933222',  // pinned 2026-09-03
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    bytes: 1107409472,
    license: 'Apache-2.0',
  },
};

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export function fmtBytes(n) {
  if (n >= GiB) return `${(n / GiB).toFixed(2)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(0)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

export function totalBytes(name) {
  const spec = MANIFEST[name];
  if (!spec) return 0;
  return spec.kind === 'llm'
    ? spec.bytes
    : spec.kind === 'file'
      ? spec.bytes
      : Object.values(spec.files).reduce((a, b) => a + b, 0);
}

async function readLock() {
  try {
    return JSON.parse(await fsp.readFile(LOCK_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeLock(lock) {
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  await fsp.writeFile(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

const sizeIs = (file, want) =>
  fsp.stat(file).then((s) => s.size === want).catch(() => false);

/**
 * Download with HTTP Range resume. Writes to <dest>.part and only moves it into
 * place once the byte count matches exactly, so an interrupted run never leaves
 * a truncated model that looks valid on disk.
 */
async function download(url, dest, expectedBytes, label, onProgress) {
  const part = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  let have = await fsp.stat(part).then((s) => s.size).catch(() => 0);
  if (have > expectedBytes) {
    await fsp.rm(part, { force: true });
    have = 0;
  }
  if (have === expectedBytes) {
    await fsp.rename(part, dest);
    return;
  }

  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) {
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  if (have > 0 && res.status !== 206) {
    // Server ignored our Range header, restart rather than corrupt the file.
    await fsp.rm(part, { force: true });
    have = 0;
  }

  const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });

  // A write stream with no 'error' listener does two bad things at once: it
  // throws an uncaught exception (a raw stack-trace dialog under Electron) AND
  // leaves the await on 'drain' pending forever, so the caller hangs. Racing the
  // error against every await is what actually settles the promise.
  const failed = new Promise((_, reject) => out.on('error', reject));

  let seen = have;
  let lastTick = 0;
  const started = Date.now();
  // Carriage-return progress is meaningless in a redirected log, skip it there.
  const showProgress = expectedBytes > 8 * MiB && process.stdout.isTTY;

  try {
    for await (const chunk of res.body) {
      if (!out.write(chunk)) {
        await Promise.race([failed, new Promise((r) => out.once('drain', r))]);
      }
      seen += chunk.length;
      onProgress?.({ label, received: seen, total: expectedBytes });
      if (showProgress && Date.now() - lastTick > 400) {
        lastTick = Date.now();
        const pct = ((seen / expectedBytes) * 100).toFixed(1);
        const mbps = (seen - have) / MiB / ((lastTick - started) / 1000);
        process.stdout.write(
          `\r   ${label.padEnd(22)} ${pct.padStart(5)}%  ${fmtBytes(seen)} / ${fmtBytes(expectedBytes)}  ${mbps.toFixed(1)} MiB/s    `
        );
      }
    }
    await Promise.race([
      failed,
      new Promise((res2, rej) => out.end((e) => (e ? rej(e) : res2()))),
    ]);
  } catch (err) {
    out.destroy();
    if (showProgress) process.stdout.write('\r' + ' '.repeat(86) + '\r');
    if (err?.code === 'ENOSPC') {
      // The default message here would be "size mismatch, upstream may have
      // changed", which is an actively wrong diagnosis of a full disk.
      throw new Error(
        `${label}: out of disk space. Free some space and re-run, the partial ` +
          `download resumes rather than starting over.`
      );
    }
    throw err;
  }
  if (showProgress) process.stdout.write('\r' + ' '.repeat(86) + '\r');

  const got = await fsp.stat(part).then((s) => s.size);
  if (got !== expectedBytes) {
    // Leave the .part alone only when it is short; a longer-than-expected file
    // means upstream changed, and resuming from it would never converge.
    if (got > expectedBytes) await fsp.rm(part, { force: true });
    throw new Error(
      `${label}: expected ${expectedBytes} bytes, got ${got}. ` +
        `The file upstream has probably changed. Re-run to fetch it again.`
    );
  }
  await fsp.rename(part, dest);
}

async function verifyOrPin(key, file, lock) {
  const st = await fsp.stat(file);
  const rec = lock[key];
  const shipped = PINS[key];

  // Hashing the 652 MB encoder before every transcription costs seconds of dead
  // time behind a "Transcribing..." message. If size and mtime are unchanged
  // since the last check, the bytes are unchanged, so the cached digest stands in
  // for a re-hash. The cached digest must still equal the shipped pin to be
  // usable: otherwise a models.lock.json poisoned before this release, or by
  // anything with write access to the models directory, would keep winning the
  // fast path forever. MIN_VERIFY_MODELS=1 forces a full check.
  if (
    rec?.sha256 &&
    shipped &&
    rec.sha256 === shipped &&
    rec.size === st.size &&
    rec.mtimeMs === st.mtimeMs &&
    !process.env.MIN_VERIFY_MODELS
  ) {
    return false;
  }

  const digest = await sha256File(file);
  if (shipped && shipped !== digest) {
    throw new Error(
      `${key}: checksum mismatch.\n` +
        `  file     ${file}\n` +
        `  expected ${shipped}\n  got      ${digest}\n` +
        `The download does not match the checksum this release was built against, ` +
        `so it will not be loaded. Delete the file and re-run to fetch it again; if ` +
        `it keeps mismatching, upstream republished it and it needs review.`
    );
  }
  if (!shipped && !process.env.MIN_ALLOW_UNPINNED) {
    // The escape hatch is for the maintainer: add a MANIFEST entry, run once with
    // MIN_ALLOW_UNPINNED=1 to fetch and hash it, then copy the resulting sha256
    // into models.pins.json so everyone else gets it enforced.
    throw new Error(
      `${key}: no checksum shipped for this file in models.pins.json, refusing to ` +
        `load it. Set MIN_ALLOW_UNPINNED=1 to fetch it once and generate its pin.`
    );
  }
  lock[key] = {
    sha256: digest,
    size: st.size,
    mtimeMs: st.mtimeMs,
    pinnedAt: rec?.pinnedAt ?? new Date().toISOString(),
  };
  return true;
}

export async function ensureModel(name) {
  const spec = MANIFEST[name];
  if (!spec) throw new Error(`Unknown model "${name}". Known: ${Object.keys(MANIFEST).join(', ')}`);

  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const lock = await readLock();
  let dirty = false;

  if (spec.kind === 'llm' || spec.kind === 'file') {
    const dest = path.join(MODELS_DIR, spec.file);
    if (!(await sizeIs(dest, spec.bytes))) {
      console.log(`\n▸ ${name}  ${fmtBytes(spec.bytes)}  ${spec.license}`);
      // Entries carry either an explicit url or a HuggingFace repo + filename.
      await download(spec.url ?? hf(spec.repo, spec.file, spec.rev), dest, spec.bytes, name);
    }
    dirty = (await verifyOrPin(name, dest, lock)) || dirty;
    if (dirty) await writeLock(lock);
    return dest;
  }

  const dir = path.join(MODELS_DIR, spec.dir);
  const entries = Object.entries(spec.files);
  const missing = [];
  for (const [rel, bytes] of entries) {
    if (!(await sizeIs(path.join(dir, rel), bytes))) missing.push([rel, bytes]);
  }

  if (missing.length) {
    const need = missing.reduce((a, [, b]) => a + b, 0);
    console.log(`\n▸ ${name}  ${fmtBytes(need)} across ${missing.length} file(s)  ${spec.license}`);
    for (const [rel, bytes] of missing) {
      await download(hf(spec.repo, rel, spec.rev), path.join(dir, rel), bytes, rel);
    }
  }

  for (const [rel] of entries) {
    dirty = (await verifyOrPin(`${name}/${rel}`, path.join(dir, rel), lock)) || dirty;
  }
  if (dirty) await writeLock(lock);
  return dir;
}

/** Resolve the sherpa-onnx transducer file paths inside a model dir. */
export async function parakeetPaths(dir) {
  const files = await fsp.readdir(dir);
  const pick = (re) => {
    const f = files.find((x) => re.test(x));
    return f ? path.join(dir, f) : null;
  };
  return {
    encoder: pick(/^encoder.*\.onnx$/),
    decoder: pick(/^decoder.*\.onnx$/),
    joiner: pick(/^joiner.*\.onnx$/),
    tokens: pick(/^tokens\.txt$/),
    testWavs: path.join(dir, 'test_wavs'),
  };
}

/**
 * Are this model's files already on disk at the expected sizes? Cheap enough to
 * call before every transcription, so the UI can say "downloading 640 MB" rather
 * than promising a four-minute transcription and then silently fetching.
 */
export async function modelReady(name) {
  const spec = MANIFEST[name];
  if (!spec) return false;
  if (spec.kind === 'llm' || spec.kind === 'file') {
    return sizeIs(path.join(MODELS_DIR, spec.file), spec.bytes);
  }
  for (const [rel, bytes] of Object.entries(spec.files)) {
    if (!(await sizeIs(path.join(MODELS_DIR, spec.dir, rel), bytes))) return false;
  }
  return true;
}

export function llmPath(name) {
  const spec = MANIFEST[name];
  if (!spec || (spec.kind !== 'llm' && spec.kind !== 'file'))
    throw new Error(`${name} has no single-file path`);
  return path.join(MODELS_DIR, spec.file);
}

if (isMain(import.meta.url)) {
  const want = process.argv.slice(2);
  if (!want.length) {
    console.log('Usage: node m0/lib/models.js <name...>');
    console.log(`Known: ${Object.keys(MANIFEST).join(', ')}\n`);
    for (const [k, v] of Object.entries(MANIFEST)) {
      console.log(`  ${k.padEnd(13)} ${fmtBytes(totalBytes(k)).padStart(9)}  ${v.note}`);
    }
    process.exit(0);
  }
  const total = want.reduce((n, k) => n + totalBytes(k), 0);
  console.log(`Fetching ${want.length} model(s), ${fmtBytes(total)} total → ${MODELS_DIR}`);
  for (const name of want) {
    const at = await ensureModel(name);
    console.log(`   ✓ ${name.padEnd(13)} ${path.relative(process.cwd(), at)}`);
  }
  console.log('\nDone.');
}
