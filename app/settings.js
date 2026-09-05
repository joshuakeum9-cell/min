/**
 * User settings, one JSON file in the app's data directory.
 *
 * Kept out of the renderer on purpose. The calendar address is a secret URL
 * that grants read access to the user's whole calendar, so it lives with the
 * process that fetches it rather than in localStorage, where any injected
 * markup could read it back. Writes are atomic (write beside, then rename) so
 * a crash mid-save cannot leave a half-written file that wipes every setting.
 *
 * No Electron import: the caller passes the file path, which keeps this
 * testable under plain node.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  // Private ICS address pasted from the calendar provider. Empty means off.
  calendarUrl: '',
  // How often to re-fetch. Google publishes ICS on a delay anyway, so more
  // often than this buys nothing.
  calendarRefreshMinutes: 15,
  // Show the two-sided conversation while recording, at the cost of CPU
  // during the call. Off falls back to transcribing after the recording ends.
  liveTranscript: true,
  // Which assistant the write-up hand-off opens. Empty means clipboard only.
  provider: '',
  // Keep the window above others while recording.
  alwaysOnTop: true,
  // Show a small prompt in the corner of the screen shortly before a meeting
  // on the calendar starts, offering to take notes on it. Off is silent: the
  // calendar still fills Home, nothing pops up.
  meetingAlerts: true,
  // Drop standalone uh, um, hm and erm from transcript lines. On by default
  // because that is what a transcript from a commercial service looks like:
  // their recognisers strip disfluencies before anyone sees the text. It is
  // applied once, at the boundary every line crosses, so what is on screen
  // and what is on disk are the same words.
  stripFillers: true,
  // Where the user dragged the floating recording indicator, as "x,y" screen
  // coordinates. Empty means it has never been moved, so it opens at its
  // default corner. A string rather than a pair of numbers so it rides the
  // existing typeof allow-list untouched; main parses it with a strict pattern
  // and clamps the result to a live display, because a saved position is only
  // ever a hint and the monitor it was saved on may be gone.
  indicatorPosition: '',
});

// Only these keys are ever read from disk or accepted from the renderer. A
// settings file is user-editable, and the renderer is one XSS away from
// hostile, so an allow-list is cheaper than validating shapes after the fact.
const KEYS = Object.keys(DEFAULTS);

const TYPES = Object.fromEntries(KEYS.map((k) => [k, typeof DEFAULTS[k]]));

function pick(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (typeof v !== TYPES[k]) continue;
    if (TYPES[k] === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

export function createSettings(filePath) {
  let current = { ...DEFAULTS };
  let loaded = false;

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      current = { ...DEFAULTS, ...pick(JSON.parse(raw)) };
    } catch (err) {
      // A missing file is the normal first run. Anything else means the file
      // is corrupt; start from defaults rather than refuse to start at all,
      // but leave the bad file in place so the user can recover from it.
      current = { ...DEFAULTS };
      if (err.code !== 'ENOENT') {
        try { fs.copyFileSync(filePath, `${filePath}.bad`); } catch { /* best effort */ }
      }
    }
    loaded = true;
    return { ...current };
  }

  function write() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
  }

  return {
    load,
    all() {
      if (!loaded) load();
      return { ...current };
    },
    get(key) {
      if (!loaded) load();
      return current[key];
    },
    /** Merge known keys, persist, return the result. Unknown keys are dropped. */
    set(patch) {
      if (!loaded) load();
      current = { ...current, ...pick(patch) };
      write();
      return { ...current };
    },
    path: filePath,
  };
}
