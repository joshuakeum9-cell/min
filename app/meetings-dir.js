/**
 * MIN · where the meetings live.
 *
 * Until now this was one line repeated in five files:
 *
 *   export const MEETINGS_DIR = path.join(os.homedir(), 'Meetings');
 *
 * That is a `const` evaluated the moment the module is imported, which makes it
 * impossible to configure: by the time main.js has read its settings file,
 * every module that imported the constant has already baked in the old path.
 * The same import-order trap cost this project a broken packaged build once
 * before, with MIN_MODELS_DIR, and the comment in main.js still warns about it.
 *
 * So the folder is a FUNCTION, resolved at the moment it is used, never at
 * import. Main puts the user's choice in an environment variable once, early,
 * and every reader picks it up from there whenever it next asks.
 *
 * WHY A FOLDER SETTING AT ALL. Point it at a folder that Google Drive for
 * Desktop, OneDrive, Dropbox or iCloud syncs, and every meeting is in that
 * cloud with no sign-in, no API key and no upload code in this app: the sync
 * client already does that job and does it better than we would. Point it
 * anywhere else, or leave it alone, and MIN is exactly the local-first app it
 * has always been. One setting buys the whole feature, and the app never has
 * to know which of those is happening.
 *
 * Pure except for reading `process.env` and `os.homedir()`, and every rule is
 * under test in meetings-dir.test.js.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** The environment variable main uses to tell every other module the answer. */
export const ENV_KEY = 'MIN_MEETINGS_DIR';

/** Where meetings go when the user has never chosen: the same path as always. */
export function defaultMeetingsDir(home = os.homedir()) {
  return path.join(home, 'Meetings');
}

/**
 * Resolve a setting value to an absolute folder.
 *
 * Anything blank, non-string or whitespace falls back to the default rather
 * than throwing. A settings file is user-editable and the renderer is one XSS
 * away from hostile, so a bad value must degrade to the safe path instead of
 * stopping the app from starting.
 */
export function resolveMeetingsDir(value, home = os.homedir()) {
  if (typeof value !== 'string') return defaultMeetingsDir(home);
  const trimmed = value.trim();
  if (!trimmed) return defaultMeetingsDir(home);
  // A relative path here would resolve against whatever the working directory
  // happened to be, which for a packaged Electron app is not something the user
  // can predict or the app should honour.
  if (!path.isAbsolute(trimmed)) return defaultMeetingsDir(home);
  return path.resolve(trimmed);
}

/**
 * The folder to use right now. Reads the environment variable main set, and
 * falls back to the default for every other process and every test.
 */
export function meetingsDir() {
  return resolveMeetingsDir(process.env[ENV_KEY]);
}

/** Publish the choice to every module in this process. Main calls this once. */
export function setMeetingsDir(value) {
  const resolved = resolveMeetingsDir(value);
  process.env[ENV_KEY] = resolved;
  return resolved;
}

/**
 * Why a chosen folder cannot be used, or null if it can.
 *
 * Checked before saving rather than after, because the failure mode otherwise
 * is a person changing the setting and finding their meetings apparently gone.
 * The `exists` and `isDirectory` facts are passed in rather than read here, so
 * this stays pure and the caller does the one stat.
 */
export function whyNotUsable(value, { exists, isDirectory, parentExists } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;   // blank means default
  const full = value.trim();
  if (!path.isAbsolute(full)) return 'Give a full path, starting with a drive letter.';
  if (exists && !isDirectory) return 'That is a file, not a folder.';
  if (!exists && parentExists === false) {
    return 'That folder does not exist, and neither does the folder above it.';
  }
  return null;
}

/**
 * The name MIN gives its own folder inside whichever cloud folder is chosen.
 * A person's Drive is theirs, so MIN takes one clearly labelled corner of it
 * rather than scattering meeting folders across the top level.
 */
export const CLOUD_SUBFOLDER = 'MIN Meetings';

/**
 * Where a sync client might already be keeping a folder on this hard drive.
 *
 * This is the whole trick behind syncing without an account: MIN never talks to
 * Google, Microsoft or Dropbox. It writes files into a folder on the hard drive
 * that one of their programs is already watching, and that program does the
 * uploading. So all MIN has to do is find such a folder.
 *
 * Pure: it returns every path worth looking at, and the caller stats them. The
 * candidates are ordered so the first one that exists is the one to offer.
 *
 * Google Drive for Desktop mounts as a drive letter with "My Drive" inside it
 * (G:\My Drive on this machine), and can also be mounted as a folder in the
 * home directory, so both shapes are checked. OneDrive exports its own
 * environment variable on Windows and is present on essentially every Windows
 * PC already, which makes it the one that needs no install at all.
 */
export function syncFolderCandidates({ home = os.homedir(), env = process.env, letters } = {}) {
  const out = [];
  const add = (id, name, p) => { if (p) out.push({ id, name, path: path.normalize(p) }); };

  const drives = letters ?? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of drives) add('google', 'Google Drive', `${letter}:\\My Drive`);
  add('google', 'Google Drive', path.join(home, 'My Drive'));

  add('onedrive', 'OneDrive', env.OneDrive);
  add('onedrive', 'OneDrive', env.OneDriveConsumer);
  add('onedrive', 'OneDrive', path.join(home, 'OneDrive'));

  add('dropbox', 'Dropbox', path.join(home, 'Dropbox'));
  add('icloud', 'iCloud Drive', path.join(home, 'iCloudDrive'));

  // Same folder reached two ways is one candidate, and the earlier one wins.
  const seen = new Set();
  return out.filter((c) => {
    const key = c.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where MIN's settings file sits, for the processes that have no Electron `app`
 * to ask. The MCP server runs under plain node inside Claude Desktop, and it
 * has to find the same meetings the app is writing, or it answers questions
 * about an empty folder while the real one fills up.
 *
 * Mirrors Electron's own userData rule: %APPDATA%\MIN on Windows,
 * ~/Library/Application Support/MIN on macOS, ~/.config/MIN elsewhere.
 */
export function settingsFilePath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'MIN', 'settings.json');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'MIN', 'settings.json');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'MIN', 'settings.json');
}

/**
 * Read the folder out of a settings file's text. Takes the text rather than the
 * path so it stays pure; a missing or corrupt file is not an error, it means
 * "the user has not chosen", which is the default.
 */
export function meetingsDirFromSettingsText(text, home = os.homedir()) {
  try {
    const parsed = JSON.parse(String(text ?? ''));
    return resolveMeetingsDir(parsed?.meetingsDir, home);
  } catch {
    return defaultMeetingsDir(home);
  }
}

/**
 * Adopt the folder the app has been pointed at, for a process that is not the
 * app.
 *
 * Every command-line entry point needs this. `node app/transcribe.js --all`,
 * `node app/prompt.js` and the Granola importer each resolved the DEFAULT
 * folder, so the moment someone pointed MIN at a synced folder the tools were
 * quietly working on a different, usually empty, directory than the app. The
 * MCP server had the same problem and solved it by hand; now there is one
 * helper and one behaviour.
 *
 * A missing or unreadable settings file is not an error. It means the app has
 * never saved one, and the default is then exactly right.
 */
export function loadMeetingsDirFromSettings() {
  try {
    return setMeetingsDir(meetingsDirFromSettingsText(fs.readFileSync(settingsFilePath(), 'utf8')));
  } catch {
    return meetingsDir();
  }
}
