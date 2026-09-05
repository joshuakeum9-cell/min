/**
 * The settings view: binds the controls in #viewSettings to the settings file.
 *
 * Every change saves as it happens. There is no Save button because there is
 * nothing to stage: each setting is independent and takes effect the moment it
 * lands, so a button would only add a way to lose an edit.
 *
 * The calendar address is a bearer credential for the user's whole calendar.
 * Nothing in this file logs it, echoes it into a status line, or puts it into
 * an error message. The main process follows the same rule (see calendar.js).
 */

/**
 * The assistants a user might already pay for. The app never sees a login: it
 * puts the prompt on the clipboard and opens the provider's site in the normal
 * browser, where the user is already signed in. Empty id means clipboard only.
 */
export const PROVIDERS = [
  { id: 'claude',     name: 'Claude' },
  { id: 'chatgpt',    name: 'ChatGPT' },
  { id: 'gemini',     name: 'Gemini' },
  { id: 'copilot',    name: 'Copilot' },
  { id: 'perplexity', name: 'Perplexity' },
  { id: 'grok',       name: 'Grok' },
  { id: 'mistral',    name: 'Le Chat' },
  { id: 'deepseek',   name: 'DeepSeek' },
  { id: '',           name: 'Clipboard only' },
];

/** Refresh intervals offered, in minutes. Google publishes ICS on a delay anyway. */
const REFRESH_CHOICES = [5, 15, 30, 60];

const $ = (id) => document.getElementById(id);

/**
 * Accept only an https address. Google, Outlook, iCloud and Fastmail all hand
 * out https (or webcal, which is https by another name), and a plain http feed
 * would send the secret in clear text. Returns the normalised URL, or null
 * with a reason the user can act on.
 */
export function validateCalendarUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { url: '', error: null };
  const url = trimmed.replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(url)) {
    return { url: null, error: 'The address must start with https://' };
  }
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) throw new Error('no host');
  } catch {
    return { url: null, error: 'That does not look like a complete web address.' };
  }
  return { url, error: null };
}

/** Fill a select once, leaving any options the markup already carries alone. */
function fillSelect(sel, options) {
  if (!sel || sel.options.length) return;
  for (const { value, label } of options) {
    const o = document.createElement('option');
    o.value = String(value);
    o.textContent = label;
    sel.appendChild(o);
  }
}

export function initSettings({ api }) {
  const urlEl = $('calendarUrl');
  const testBtn = $('calendarTest');
  const refreshSel = $('calendarRefresh');
  const liveEl = $('liveTranscript');
  const onTopEl = $('alwaysOnTop');
  const providerSel = $('defaultProvider');
  const openDirBtn = $('openMeetingsDir');

  // Feedback for the calendar group. Created beside the test button when the
  // markup has no slot for it, so the count and any error have somewhere to go.
  let noteEl = $('calendarStatus');
  if (!noteEl && testBtn) {
    noteEl = document.createElement('span');
    noteEl.id = 'calendarStatus';
    noteEl.className = 'settings-note';
    testBtn.insertAdjacentElement('afterend', noteEl);
  }
  const note = (text, cls = '') => {
    if (!noteEl) return;
    noteEl.className = ['settings-note', cls].filter(Boolean).join(' ');
    noteEl.textContent = text;
  };

  fillSelect(refreshSel, REFRESH_CHOICES.map((m) => ({
    value: m, label: m === 60 ? 'Every hour' : `Every ${m} minutes`,
  })));
  fillSelect(providerSel, PROVIDERS.map((p) => ({ value: p.id, label: p.name })));

  let current = {};

  /** Push the settings object into the controls. */
  function render(s) {
    current = s ?? {};
    if (urlEl) urlEl.value = current.calendarUrl ?? '';
    if (refreshSel) {
      const minutes = Number(current.calendarRefreshMinutes) || 15;
      // A hand-edited settings file can hold an interval the menu does not
      // offer; show it rather than silently snapping to the nearest choice.
      if (![...refreshSel.options].some((o) => Number(o.value) === minutes)) {
        const o = document.createElement('option');
        o.value = String(minutes);
        o.textContent = `Every ${minutes} minutes`;
        refreshSel.appendChild(o);
      }
      refreshSel.value = String(minutes);
    }
    if (liveEl) liveEl.checked = Boolean(current.liveTranscript);
    if (onTopEl) onTopEl.checked = Boolean(current.alwaysOnTop);
    if (providerSel) {
      const id = current.provider ?? '';
      providerSel.value = PROVIDERS.some((p) => p.id === id) ? id : '';
    }
  }

  /** Save one patch and re-render from what the main process kept. */
  async function save(patch) {
    try {
      render(await api.settingsSet(patch));
      return true;
    } catch (e) {
      note('Could not save: ' + e.message, 'warn');
      return false;
    }
  }

  // The address saves on change (blur or Enter), not on every keystroke: a
  // half-pasted URL would otherwise be fetched and fail before it is complete.
  urlEl?.addEventListener('change', async () => {
    const { url, error } = validateCalendarUrl(urlEl.value);
    if (error) { note(error, 'warn'); return; }
    urlEl.value = url;
    if (url === (current.calendarUrl ?? '')) return;
    if (await save({ calendarUrl: url })) {
      note(url ? 'Saved. Press Test connection to check it.' : 'Calendar disconnected.');
    }
  });

  testBtn?.addEventListener('click', async () => {
    const { url, error } = validateCalendarUrl(urlEl?.value ?? current.calendarUrl);
    if (error) { note(error, 'warn'); return; }
    if (!url) { note('Paste your secret iCal address first.', 'warn'); return; }
    // Commit an unsaved edit so the test runs against what is on screen.
    if (url !== (current.calendarUrl ?? '')) {
      if (urlEl) urlEl.value = url;
      if (!(await save({ calendarUrl: url }))) return;
    }
    testBtn.disabled = true;
    note('Fetching your calendar...');
    try {
      const r = await api.calendarRefresh();
      if (r?.ok) {
        const n = Number(r.count) || 0;
        note(`Found ${n} event${n === 1 ? '' : 's'}.`, 'good');
      } else {
        note(r?.error || 'The calendar could not be fetched.', 'warn');
      }
    } catch (e) {
      note(e.message || 'The calendar could not be fetched.', 'warn');
    } finally {
      testBtn.disabled = false;
    }
  });

  refreshSel?.addEventListener('change', () => {
    const minutes = Number(refreshSel.value);
    if (Number.isFinite(minutes) && minutes > 0) save({ calendarRefreshMinutes: minutes });
  });
  liveEl?.addEventListener('change', () => save({ liveTranscript: liveEl.checked }));
  onTopEl?.addEventListener('change', () => save({ alwaysOnTop: onTopEl.checked }));
  providerSel?.addEventListener('change', () => save({ provider: providerSel.value }));

  openDirBtn?.addEventListener('click', async () => {
    try {
      await api.openFolder(await api.meetingsDir());
    } catch (e) {
      note('Could not open the folder: ' + e.message, 'warn');
    }
  });

  // About group. The ids are optional: the version and path rows render when
  // the markup provides them and are skipped otherwise.
  api.meetingsDir?.().then((d) => {
    const el = $('meetingsPath');
    if (el && d) el.textContent = d;
  }).catch(() => {});
  api.appVersion?.().then((v) => {
    const el = $('settingsVersion');
    if (el && v) el.textContent = 'v' + String(v).replace(/^v/, '');
  }).catch(() => {});

  api.settingsGet().then(render).catch((e) => note('Settings could not be read: ' + e.message, 'warn'));

  return { render };
}
