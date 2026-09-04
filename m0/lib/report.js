/** Result persistence for M0 benchmarks. One JSON per run, never overwritten. */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.resolve(HERE, '../../results');

export async function saveResult(name, payload) {
  await fsp.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `${name}-${stamp}.json`);
  await fsp.writeFile(
    file,
    JSON.stringify({ benchmark: name, at: new Date().toISOString(), ...payload }, null, 2) + '\n'
  );
  return file;
}

export async function loadResults(name) {
  const files = await fsp.readdir(RESULTS_DIR).catch(() => []);
  const matching = files.filter((f) => f.startsWith(`${name}-`) && f.endsWith('.json')).sort();
  const out = [];
  for (const f of matching) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(RESULTS_DIR, f), 'utf8')));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}
