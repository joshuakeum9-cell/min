/**
 * MIN, meeting detection: who is using the microphone right now.
 *
 * Granola's "Meeting detected" card does not listen to anything. It notices
 * that another program has opened the microphone, and on Windows that is a
 * matter of public record: every app that touches the microphone gets an
 * entry under
 *
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager
 *       \ConsentStore\microphone
 *
 * with two FILETIME values, LastUsedTimeStart and LastUsedTimeStop. While the
 * app holds the microphone, Stop is zero. That is the whole signal, it is
 * exactly what the microphone icon in the system tray reads, and it costs
 * nothing that the user would have to trust MIN with: MIN never opens the
 * microphone to watch for a meeting, it reads the note Windows already keeps.
 *
 * Classic programs are keyed by their path with every backslash turned into a
 * '#'. Store apps are keyed by their package family name, like
 * "MSTeams_8wekyb3d8bbwe". Both are handled, and both produce a name a person
 * would call the app.
 *
 * Pure: no imports, so it runs under plain node for its test and could be
 * imported by the renderer if a settings pane needs to name a muted app.
 */

/** 1601-01-01 to 1970-01-01, in the 100 ns ticks a FILETIME counts. */
const EPOCH_DIFF_TICKS = 116444736000000000n;

/** `0x1dd2a85cf6ef024` as printed by reg.exe, to epoch milliseconds. 0 stays 0. */
export function filetimeToMs(hex) {
  const s = String(hex ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(s)) return null;
  const ticks = BigInt(s);
  if (ticks === 0n) return 0;
  if (ticks < EPOCH_DIFF_TICKS) return null;
  return Number((ticks - EPOCH_DIFF_TICKS) / 10000n);
}

/**
 * Parse the output of `reg query <microphone key> /s`.
 *
 * Returns one record per app subkey that carries a LastUsedTimeStart, newest
 * start first. The root key (which only holds the global Allow/Deny value) and
 * subkeys that have never been used are left out. `active` is the bit that
 * matters: a Start with no Stop.
 *
 * @param {string} text  what reg.exe printed
 * @returns {Array<{key:string, kind:'exe'|'package', path:string|null, exe:string, startMs:number, stopMs:number, active:boolean}>}
 */
export function parseMicUse(text) {
  const out = [];
  let cur = null;
  const finish = () => {
    if (!cur || cur.startMs === null) { cur = null; return; }
    out.push({
      key: cur.key,
      kind: cur.kind,
      path: cur.path,
      exe: cur.exe,
      startMs: cur.startMs,
      stopMs: cur.stopMs ?? 0,
      active: cur.startMs > 0 && !(cur.stopMs > 0),
    });
    cur = null;
  };

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const head = /^HKEY_[A-Z_]+\\(.+)$/.exec(line);
    if (head) {
      finish();
      const full = head[1];
      const m = /ConsentStore\\microphone\\(.+)$/i.exec(full);
      if (!m) { cur = null; continue; }        // the root key itself
      let rel = m[1];
      let kind = 'package';
      if (/^NonPackaged\\/i.test(rel)) { kind = 'exe'; rel = rel.slice('NonPackaged\\'.length); }
      const path = kind === 'exe' ? rel.replace(/#/g, '\\') : null;
      cur = { key: rel, kind, path, exe: kind === 'exe' ? basename(path) : rel, startMs: null, stopMs: null };
      continue;
    }
    if (!cur) continue;
    const v = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-fA-F]+)\s*$/.exec(line);
    if (!v) continue;
    const ms = filetimeToMs(v[2]);
    if (v[1] === 'LastUsedTimeStart') cur.startMs = ms;
    else cur.stopMs = ms;
  }
  finish();
  out.sort((a, b) => b.startMs - a.startMs);
  return out;
}

function basename(p) {
  const s = String(p ?? '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Programs that touch the microphone without there being a meeting: pieces of
 * Windows itself, the Settings app testing the mic, driver helpers. A card for
 * any of these would be noise, so they are never offered, and they cannot be
 * un-muted from Settings because they were never a choice.
 */
const SYSTEM_NOISE = new Set([
  'rundll32.exe', 'nvcontainer.exe', 'svchost.exe', 'audiodg.exe', 'explorer.exe',
  'shellexperiencehost.exe', 'searchhost.exe', 'startmenuexperiencehost.exe',
  'systemsettings.exe', 'voiceaccess.exe', 'speechruntime.exe',
]);
const SYSTEM_NOISE_PACKAGES = [
  /^windows\.immersivecontrolpanel_/i,      // the Settings app's microphone test
  /^microsoftwindows\.client\.cbs_/i,        // Windows shell components
  /^microsoft\.windows\.shellexperiencehost/i,
  /^microsoftwindows\.client\.core_/i,
  /^microsoft\.windows\.search_/i,
  /^microsoft\.windows\.cortana_/i,
];

export function isSystemNoise(entry) {
  if (!entry) return true;
  if (entry.kind === 'exe') return SYSTEM_NOISE.has(String(entry.exe).toLowerCase());
  return SYSTEM_NOISE_PACKAGES.some((re) => re.test(entry.key));
}

/**
 * Is this entry MIN itself, in any of its forms: the installed MIN-Notes.exe,
 * or the development electron.exe run from the repo. Compared by path, with
 * the registry's '#' turned back into a separator, case-insensitively, because
 * Windows paths are. `selfPaths` is what main passes: process.execPath and,
 * in development, the repo root.
 */
export function isSelf(entry, selfPaths = []) {
  if (!entry || entry.kind !== 'exe' || !entry.path) return false;
  const p = norm(entry.path);
  return selfPaths.some((s) => {
    const n = norm(s);
    return n && (p === n || (n.endsWith('\\') ? p.startsWith(n) : p.startsWith(n + '\\')));
  });
}

function norm(p) {
  return String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The name a person would use for the app, from its executable or package.
 *
 * A short table for the programs that matter and would otherwise come out
 * wrong (Webex's binary is "atmgr.exe", Teams is a package family name), then
 * a fallback that turns "SomeVendor.SomeProduct_hash" or "some-product.exe"
 * into title case. Never empty: an unknown key still gets a readable name.
 */
const KNOWN_EXE = {
  'chrome.exe': 'Chrome', 'msedge.exe': 'Edge', 'msedgewebview2.exe': 'Edge', 'firefox.exe': 'Firefox',
  'brave.exe': 'Brave', 'opera.exe': 'Opera', 'vivaldi.exe': 'Vivaldi', 'arc.exe': 'Arc',
  'zoom.exe': 'Zoom', 'cpthost.exe': 'Zoom', 'atmgr.exe': 'Webex', 'ciscocollabhost.exe': 'Webex', 'webexhost.exe': 'Webex',
  'ms-teams.exe': 'Teams', 'teams.exe': 'Teams', 'slack.exe': 'Slack', 'discord.exe': 'Discord',
  'skype.exe': 'Skype', 'telegram.exe': 'Telegram', 'signal.exe': 'Signal', 'kakaotalk.exe': 'KakaoTalk',
  'whatsapp.exe': 'WhatsApp', 'line.exe': 'LINE', 'wechat.exe': 'WeChat', 'ringcentral.exe': 'RingCentral',
  'gotomeeting.exe': 'GoToMeeting', 'bluejeans.exe': 'BlueJeans', 'obs64.exe': 'OBS', 'obs32.exe': 'OBS',
  'audacity.exe': 'Audacity', 'granola.exe': 'Granola', 'powershell.exe': 'PowerShell', 'pwsh.exe': 'PowerShell',
  'claude.exe': 'Claude', 'notion.exe': 'Notion', 'loom.exe': 'Loom', 'electron.exe': 'Electron',
  'min-notes.exe': 'MIN',
};
const KNOWN_PACKAGE = [
  [/^msteams_/i, 'Teams'], [/^microsoftteams_/i, 'Teams'], [/^microsoft\.skypeapp_/i, 'Skype'],
  [/whatsappdesktop_/i, 'WhatsApp'], [/^claude_/i, 'Claude'], [/slackdesktop_/i, 'Slack'],
  [/^microsoft\.windowssoundrecorder_/i, 'Sound Recorder'], [/^zoom/i, 'Zoom'], [/^telegram/i, 'Telegram'],
  [/^discord/i, 'Discord'], [/^spotify/i, 'Spotify'],
];

export function labelFor(entry) {
  if (!entry) return 'An app';
  return entry.kind === 'exe' ? labelForExe(entry.exe) : labelForPackage(entry.key);
}

/** The same, from a raw registry key as stored in settings (mute list). */
export function labelForKey(key) {
  const k = String(key ?? '');
  if (!k) return 'An app';
  if (k.includes('#') || /\.exe$/i.test(k)) return labelForExe(basename(k.replace(/#/g, '\\')));
  return labelForPackage(k);
}

function labelForExe(exe) {
  const e = String(exe ?? '').toLowerCase();
  if (KNOWN_EXE[e]) return KNOWN_EXE[e];
  return titleCase(e.replace(/\.exe$/, '')) || 'An app';
}

function labelForPackage(key) {
  const k = String(key ?? '');
  for (const [re, name] of KNOWN_PACKAGE) if (re.test(k)) return name;
  // "Publisher.ProductName_hash" -> "Product Name"
  const stem = k.replace(/_[a-z0-9]+$/i, '');
  const last = stem.includes('.') ? stem.slice(stem.lastIndexOf('.') + 1) : stem;
  return titleCase(last.replace(/([a-z])([A-Z])/g, '$1 $2')) || 'An app';
}

function titleCase(s) {
  return String(s ?? '')
    .split(/[\s._\-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Which active entries deserve a card right now.
 *
 * Everything that is active, minus system noise, minus MIN itself, minus the
 * apps the user muted, minus sessions already offered. A session is one app
 * holding the microphone from one start time: the same app opening it again
 * later is a new meeting and gets a new card.
 *
 * @param {ReturnType<typeof parseMicUse>} entries
 * @param {{selfPaths?:string[], muted?:Iterable<string>, seen?:Iterable<string>}} opts
 */
export function sessionId(entry) {
  return `${entry.key}|${entry.startMs}`;
}

export function pendingDetections(entries, { selfPaths = [], muted = [], seen = [] } = {}) {
  const mutedSet = new Set([...muted].map((k) => String(k).toLowerCase()));
  const seenSet = new Set(seen);
  return entries.filter((e) =>
    e.active &&
    !isSystemNoise(e) &&
    !isSelf(e, selfPaths) &&
    !mutedSet.has(e.key.toLowerCase()) &&
    !seenSet.has(sessionId(e)));
}
