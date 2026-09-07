/**
 * MIN · meeting-detection tests. Run: node app/mic-watch.test.js
 *
 * No framework, like the other suites. The fixture is the real thing: the
 * shape reg.exe prints for the microphone consent store on this machine on
 * 2026-09-07, with the values that matter set by hand so the arithmetic is
 * checkable. 0x19db1ded53e8000 is 1970-01-01T00:00:00Z as a FILETIME, which
 * makes epoch conversion an exact test rather than a plausible one.
 */

import {
  filetimeToMs, parseMicUse, isSystemNoise, isSelf, labelFor, labelForKey, pendingDetections, sessionId,
} from './mic-watch.js';

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

const ROOT = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const EPOCH = '0x19db1ded53e8000';           // 1970-01-01T00:00:00Z
// Computed, not typed: a FILETIME counts 100 ns ticks, so one second is ten
// million of them, and a hand-added hex constant here was wrong by a factor of
// sixteen the first time.
const plus = (seconds) => '0x' + (BigInt(EPOCH) + BigInt(seconds) * 10000000n).toString(16);
const EPOCH_PLUS_1S = plus(1);
const EPOCH_PLUS_2S = plus(2);

// Exactly how reg.exe /s prints it: blank line, key, four-space-indented values.
const FIXTURE = [
  '',
  ROOT,
  '    Value    REG_SZ    Allow',
  '',
  `${ROOT}\\MSTeams_8wekyb3d8bbwe`,
  '    Value    REG_SZ    Allow',
  '    LastSetTime    REG_QWORD    0x1dc57d43f5fac9c',
  `    LastUsedTimeStart    REG_QWORD    ${EPOCH}`,
  '    LastUserAnnotatedLabel    REG_DWORD    0x2',
  `    LastUsedTimeStop    REG_QWORD    ${EPOCH_PLUS_1S}`,
  '    PersistedInDatabase    REG_DWORD    0x1',
  '',
  `${ROOT}\\com.tinyspeck.slackdesktop_8yrtsj140pw4g`,
  '    Value    REG_SZ    Prompt',
  '    LastSetTime    REG_QWORD    0x1dc60df1b724939',
  '',
  `${ROOT}\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe`,
  '    Value    REG_SZ    Allow',
  `    LastUsedTimeStart    REG_QWORD    ${EPOCH_PLUS_1S}`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${ROOT}\\NonPackaged\\C:#Users#Alex#AppData#Local#Programs#MIN-Notes#MIN-Notes.exe`,
  `    LastUsedTimeStart    REG_QWORD    ${EPOCH_PLUS_1S}`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${ROOT}\\NonPackaged\\C:#Windows#System32#rundll32.exe`,
  `    LastUsedTimeStart    REG_QWORD    ${EPOCH_PLUS_1S}`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${ROOT}\\NonPackaged\\C:#Users#Alex#AppData#Roaming#Zoom#bin#Zoom.exe`,
  `    LastUsedTimeStart    REG_QWORD    ${EPOCH_PLUS_2S}`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${ROOT}\\windows.immersivecontrolpanel_cw5n1h2txyewy`,
  `    LastUsedTimeStart    REG_QWORD    ${EPOCH_PLUS_1S}`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
].join('\r\n');

section('filetime');
{
  eq('the epoch converts to 0 ms exactly', filetimeToMs(EPOCH), 0);
  eq('ten million ticks later is one second', filetimeToMs(EPOCH_PLUS_1S), 1000);
  eq('zero stays zero, which is how "still in use" is encoded', filetimeToMs('0x0'), 0);
  eq('a value before 1970 is refused rather than negative', filetimeToMs('0x1'), null);
  eq('garbage is refused', filetimeToMs('not hex'), null);
  eq('and so is nothing', filetimeToMs(undefined), null);
}

section('parsing what reg.exe prints');
const entries = parseMicUse(FIXTURE);
{
  eq('one record per subkey that has ever been used, root and never-used skipped', entries.length, 6);
  const keys = entries.map((e) => e.key);
  ok('the root key is not a record', !keys.some((k) => /^$/.test(k)));
  ok('slack, which only has a prompt setting, is not a record', !keys.some((k) => /slack/i.test(k)));
  const chrome = entries.find((e) => e.exe === 'chrome.exe');
  eq('a classic exe is kind exe with its path restored from the # form', [chrome.kind, chrome.path], ['exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']);
  eq('its key is the raw registry form, which is what the mute list stores', chrome.key, 'C:#Program Files#Google#Chrome#Application#chrome.exe');
  eq('chrome is active: a start and no stop', [chrome.startMs, chrome.stopMs, chrome.active], [1000, 0, true]);
  const teams = entries.find((e) => e.key.startsWith('MSTeams'));
  eq('a store app is kind package with no path', [teams.kind, teams.path, teams.exe], ['package', null, 'MSTeams_8wekyb3d8bbwe']);
  eq('teams is not active: it stopped one second after it started', [teams.startMs, teams.stopMs, teams.active], [0, 1000, false]);
  eq('newest start first', entries[0].startMs >= entries[entries.length - 1].startMs, true);
  eq('a Windows-style CRLF file parses the same as LF', parseMicUse(FIXTURE.replace(/\r\n/g, '\n')).length, 6);
  eq('empty input is an empty list, not a throw', parseMicUse(''), []);
}

section('what is noise, what is MIN, what is a meeting');
{
  const by = (exe) => entries.find((e) => e.exe === exe || e.key === exe);
  ok('rundll32 is system noise', isSystemNoise(by('rundll32.exe')));
  ok('the Settings app mic test is system noise', isSystemNoise(by('windows.immersivecontrolpanel_cw5n1h2txyewy')));
  ok('chrome is not', !isSystemNoise(by('chrome.exe')));
  ok('zoom is not', !isSystemNoise(by('Zoom.exe')));
  const self = ['C:\\Users\\Alex\\AppData\\Local\\Programs\\MIN-Notes\\MIN-Notes.exe'];
  ok('the installed MIN is recognised as self by exact path', isSelf(by('MIN-Notes.exe'), self));
  ok('case does not matter, this is Windows', isSelf(by('MIN-Notes.exe'), [self[0].toUpperCase()]));
  ok('a repo root passed as self covers electron.exe under it',
    isSelf({ kind: 'exe', path: 'C:\\Users\\Alex\\Projects\\min\\node_modules\\electron\\dist\\electron.exe' }, ['C:/Users/Alex/Projects/min']));
  ok('but not a sibling folder with the same prefix',
    !isSelf({ kind: 'exe', path: 'C:\\Users\\Alex\\Projects\\minx\\electron.exe' }, ['C:/Users/Alex/Projects/min']));
  ok('chrome is not self', !isSelf(by('chrome.exe'), self));
  ok('a package entry is never self', !isSelf(by('MSTeams_8wekyb3d8bbwe'), self));
}

section('names a person would use');
{
  const by = (exe) => entries.find((e) => e.exe === exe || e.key === exe);
  eq('chrome.exe', labelFor(by('chrome.exe')), 'Chrome');
  eq('Zoom.exe', labelFor(by('Zoom.exe')), 'Zoom');
  eq('the Teams package family', labelFor(by('MSTeams_8wekyb3d8bbwe')), 'Teams');
  eq('MIN itself', labelFor(by('MIN-Notes.exe')), 'MIN');
  eq('webex, whose binary is atmgr.exe', labelFor({ kind: 'exe', exe: 'atmgr.exe' }), 'Webex');
  eq('an unknown exe is title-cased from its name', labelFor({ kind: 'exe', exe: 'some-call-app.exe' }), 'Some Call App');
  eq('an unknown package is title-cased from its product part', labelFor({ kind: 'package', key: 'Contoso.VideoMeet_abc123def' }), 'Video Meet');
  eq('the same from a raw key, exe form', labelForKey('C:#Program Files#Google#Chrome#Application#chrome.exe'), 'Chrome');
  eq('the same from a raw key, package form', labelForKey('MSTeams_8wekyb3d8bbwe'), 'Teams');
  eq('WhatsApp store package', labelForKey('5319275A.WhatsAppDesktop_cv1g1gvanyjgm'), 'WhatsApp');
  eq('an empty key still yields a name', labelForKey(''), 'An app');
  eq('nothing at all still yields a name', labelFor(null), 'An app');
}

section('which sessions get a card');
{
  const self = ['C:\\Users\\Alex\\AppData\\Local\\Programs\\MIN-Notes\\MIN-Notes.exe'];
  const due = pendingDetections(entries, { selfPaths: self });
  eq('active, not noise, not MIN: zoom and chrome, newest first', due.map((e) => e.exe), ['Zoom.exe', 'chrome.exe']);
  const muted = pendingDetections(entries, { selfPaths: self, muted: ['c:#program files#google#chrome#application#chrome.exe'] });
  eq('a muted key is honoured case-insensitively', muted.map((e) => e.exe), ['Zoom.exe']);
  const chrome = entries.find((e) => e.exe === 'chrome.exe');
  const seen = pendingDetections(entries, { selfPaths: self, seen: [sessionId(chrome)] });
  eq('a session already offered is not offered again', seen.map((e) => e.exe), ['Zoom.exe']);
  eq('but the same app with a new start time is a new session', sessionId({ ...chrome, startMs: 5000 }) !== sessionId(chrome), true);
  eq('nothing active, nothing due', pendingDetections(parseMicUse(FIXTURE.replace(/0x0$/gm, EPOCH_PLUS_1S)), { selfPaths: self }), []);
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
