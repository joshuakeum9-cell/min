/**
 * MIN · meetings folder tests. Run: node app/meetings-dir.test.js
 *
 * No framework, like the other suites.
 *
 * The rule these check is one this app cannot afford to get wrong: a bad value
 * in a user-editable settings file must fall back to the default folder, never
 * throw and never resolve somewhere unexpected. A throw here stops MIN from
 * starting; a surprising path makes every meeting look lost.
 */

import path from 'node:path';
import {
  ENV_KEY, defaultMeetingsDir, resolveMeetingsDir, meetingsDir, setMeetingsDir,
  whyNotUsable, settingsFilePath, meetingsDirFromSettingsText,
  syncFolderCandidates, CLOUD_SUBFOLDER,
} from './meetings-dir.js';

let failures = 0;
let checks = 0;
function ok(label, condition, detail = '') {
  checks++;
  if (!condition) failures++;
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail && !condition ? ' , ' + detail : ''}`);
}
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(label, g === w, `got ${g}, want ${w}`);
}
const section = (t) => console.log(`\n${t}`);

const HOME = process.platform === 'win32' ? 'C:\\Users\\Someone' : '/home/someone';
const DEFAULT = path.join(HOME, 'Meetings');

section('the default');
{
  eq('is Meetings beside the home folder', defaultMeetingsDir(HOME), DEFAULT);
  eq('and is what an unset value resolves to', resolveMeetingsDir(undefined, HOME), DEFAULT);
}

section('resolving a setting value');
{
  eq('empty falls back', resolveMeetingsDir('', HOME), DEFAULT);
  eq('whitespace falls back', resolveMeetingsDir('   ', HOME), DEFAULT);
  eq('null falls back', resolveMeetingsDir(null, HOME), DEFAULT);
  eq('a number falls back rather than throwing', resolveMeetingsDir(42, HOME), DEFAULT);
  eq('an object falls back rather than throwing', resolveMeetingsDir({ x: 1 }, HOME), DEFAULT);
  // A relative path would resolve against the working directory, which for a
  // packaged Electron app is not somewhere the user can predict.
  eq('a relative path falls back', resolveMeetingsDir('Meetings', HOME), DEFAULT);
  eq('a dot-relative path falls back', resolveMeetingsDir('./elsewhere', HOME), DEFAULT);
}
{
  const chosen = process.platform === 'win32' ? 'G:\\My Drive\\MIN transcripts' : '/mnt/drive/MIN transcripts';
  eq('an absolute path is taken', resolveMeetingsDir(chosen, HOME), path.resolve(chosen));
  eq('and is trimmed first', resolveMeetingsDir(`  ${chosen}  `, HOME), path.resolve(chosen));
}

section('publishing it to the process');
{
  const before = process.env[ENV_KEY];
  const chosen = process.platform === 'win32' ? 'D:\\Meetings Elsewhere' : '/srv/meetings';
  const returned = setMeetingsDir(chosen);
  eq('setMeetingsDir returns the resolved path', returned, path.resolve(chosen));
  eq('and every later reader sees it', meetingsDir(), path.resolve(chosen));
  setMeetingsDir('');
  eq('clearing it returns to the default', meetingsDir(), defaultMeetingsDir());
  if (before === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = before;
}

section('refusing a folder before it is saved');
{
  const abs = process.platform === 'win32' ? 'C:\\Somewhere\\Meetings' : '/somewhere/Meetings';
  eq('blank is fine, it means the default', whyNotUsable('', {}), null);
  eq('an existing folder is fine', whyNotUsable(abs, { exists: true, isDirectory: true }), null);
  ok('a file is refused', /file, not a folder/.test(whyNotUsable(abs, { exists: true, isDirectory: false }) ?? ''));
  eq('a folder that does not exist yet is fine if its parent does',
    whyNotUsable(abs, { exists: false, parentExists: true }), null);
  ok('but not when the parent is missing too',
    /does not exist/.test(whyNotUsable(abs, { exists: false, parentExists: false }) ?? ''));
  ok('a relative path is refused', /full path/.test(whyNotUsable('Meetings', {}) ?? ''));
}

section('finding a folder some sync client already watches');
{
  const found = syncFolderCandidates({ home: 'C:\\Users\\A', env: {}, letters: ['G'] });
  const paths = found.map((c) => c.path);
  ok('Google Drive as a drive letter is looked for', paths.includes('G:\\My Drive'), JSON.stringify(paths));
  ok('and as a folder in the home directory', paths.includes(path.join('C:\\Users\\A', 'My Drive')));
  ok('OneDrive is looked for, since Windows ships with it', paths.some((p) => /OneDrive$/.test(p)));
  ok('Dropbox too', paths.some((p) => /Dropbox$/.test(p)));
  eq('every candidate is labelled for the person, not by path',
    [...new Set(found.map((c) => c.name))].sort(),
    ['Dropbox', 'Google Drive', 'OneDrive', 'iCloud Drive']);
}
{
  // OneDrive exports its own variable; the home-directory guess must not then
  // offer the same folder a second time.
  const found = syncFolderCandidates({
    home: 'C:\\Users\\A', env: { OneDrive: 'C:\\Users\\A\\OneDrive' }, letters: [],
  });
  const oneDrives = found.filter((c) => c.id === 'onedrive').map((c) => c.path);
  eq('the same folder reached two ways is offered once', oneDrives, ['C:\\Users\\A\\OneDrive']);
}
{
  const found = syncFolderCandidates({ home: 'C:\\Users\\A', env: {}, letters: ['G', 'H'] });
  const google = found.filter((c) => c.id === 'google').map((c) => c.path);
  eq('every drive letter given is checked, in order',
    google.slice(0, 2), ['G:\\My Drive', 'H:\\My Drive']);
  ok('and Google Drive is offered before OneDrive, being the one asked for',
    found.findIndex((c) => c.id === 'google') < found.findIndex((c) => c.id === 'onedrive'));
}
{
  eq('MIN takes one clearly named corner of a person\u0027s drive', CLOUD_SUBFOLDER, 'MIN Meetings');
}

section('finding MIN settings without Electron');
{
  eq('Windows uses APPDATA',
    settingsFilePath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\A\\AppData\\Roaming' }, home: 'C:\\Users\\A' }),
    path.join('C:\\Users\\A\\AppData\\Roaming', 'MIN', 'settings.json'));
  eq('Windows falls back when APPDATA is unset',
    settingsFilePath({ platform: 'win32', env: {}, home: 'C:\\Users\\A' }),
    path.join('C:\\Users\\A', 'AppData', 'Roaming', 'MIN', 'settings.json'));
  // Built with path.join rather than typed as a literal: these run on Windows
  // too, where path.join joins with backslashes whatever the strings look like.
  eq('macOS uses Application Support',
    settingsFilePath({ platform: 'darwin', env: {}, home: '/Users/a' }),
    path.join('/Users/a', 'Library', 'Application Support', 'MIN', 'settings.json'));
  eq('elsewhere uses .config',
    settingsFilePath({ platform: 'linux', env: {}, home: '/home/a' }),
    path.join('/home/a', '.config', 'MIN', 'settings.json'));
  eq('and honours XDG_CONFIG_HOME',
    settingsFilePath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/a/cfg' }, home: '/home/a' }),
    path.join('/home/a/cfg', 'MIN', 'settings.json'));
}

section('reading the folder out of a settings file');
{
  const chosen = process.platform === 'win32' ? 'G:\\My Drive\\MIN transcripts' : '/mnt/g/MIN transcripts';
  eq('a set folder is read', meetingsDirFromSettingsText(JSON.stringify({ meetingsDir: chosen }), HOME), path.resolve(chosen));
  eq('an empty one means the default', meetingsDirFromSettingsText(JSON.stringify({ meetingsDir: '' }), HOME), DEFAULT);
  eq('a file without the key means the default', meetingsDirFromSettingsText('{"liveTranscript":true}', HOME), DEFAULT);
  // The settings file is user-editable, so half-written JSON is a real case,
  // and it must not stop the MCP server from starting.
  eq('corrupt JSON means the default, not a crash', meetingsDirFromSettingsText('{ "meetingsDir": ', HOME), DEFAULT);
  eq('no file at all means the default', meetingsDirFromSettingsText(null, HOME), DEFAULT);
  eq('an empty file means the default', meetingsDirFromSettingsText('', HOME), DEFAULT);
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
