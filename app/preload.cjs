/**
 * Preload bridge. The renderer captures audio and owns the UI; everything that
 * touches disk goes through here, so the renderer keeps contextIsolation on and
 * never gets Node.
 *
 * CommonJS on purpose: Electron preloads must be .cjs when the package is
 * "type": "module".
 *
 * Every method is named individually rather than exposing a generic invoke
 * passthrough. A compromised renderer can then only reach the channels below,
 * and each one is gated again in main.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wrap a main-to-renderer event so the callback never sees Electron's event
 * object. Handing that to page code leaks `sender`, which can be used to reach
 * back into the main process.
 */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_evt, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /**
   * @param {{startedAt:number, endedAt:number, title:string, notes:string,
   *          sampleRate:number, mic:Uint8Array, system:Uint8Array,
   *          timeline:object, calendarEvent?:object}} payload
   */
  saveMeeting: (payload) => ipcRenderer.invoke('save-meeting', payload),
  transcribe: (dir) => ipcRenderer.invoke('transcribe', dir),
  copyPrompt: (dir) => ipcRenderer.invoke('copy-prompt', dir),
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  readMeeting: (dir) => ipcRenderer.invoke('read-meeting', dir),
  search: (q) => ipcRenderer.invoke('search', q),
  /** The generated write-up, note.md. */
  saveNote: (dir, text) => ipcRenderer.invoke('save-note', dir, text),
  /** The notes the user typed during the call, my-notes.md. Separate file, separate channel. */
  saveNotes: (dir, text) => ipcRenderer.invoke('save-notes', dir, text),
  deleteMeeting: (dir) => ipcRenderer.invoke('delete-meeting', dir),
  openProvider: (id) => ipcRenderer.invoke('open-provider', id),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  modelsReady: () => ipcRenderer.invoke('models-ready'),
  meetingsDir: () => ipcRenderer.invoke('meetings-dir'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('set-always-on-top', on),
  appVersion: () => ipcRenderer.invoke('app-version'),

  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings-set', patch),

  calendarRefresh: () => ipcRenderer.invoke('calendar-refresh'),
  calendarUpcoming: (opts) => ipcRenderer.invoke('calendar-upcoming', opts),
  calendarEventNow: () => ipcRenderer.invoke('calendar-event-now'),
  onCalendarUpdated: (cb) => subscribe('calendar-updated', cb),

  liveStart: (opts) => ipcRenderer.invoke('live-start', opts),
  /**
   * Fire and forget, many times a second. `send` rather than `invoke` so audio
   * never waits on a reply, and the ArrayBuffer is passed straight through
   * rather than serialised as JSON.
   */
  livePush: (track, buffer) => ipcRenderer.send('live-push', track, buffer),
  /**
   * `dir` is the meeting folder the note was just saved into. It is what lets
   * main write transcript.md; called with nothing, the lines come back in the
   * reply and are never written to disk.
   *
   * @param {string} [dir]
   */
  liveStop: (dir) => ipcRenderer.invoke('live-stop', dir),
  onLiveSegment: (cb) => subscribe('live-segment', cb),
  onLiveStatus: (cb) => subscribe('live-status', cb),

  /**
   * Recording state for the floating indicator, the window that shows the
   * meeting is still being captured once MIN is behind the call app.
   *
   * `send` for the same reason as livePush: this fires on every animation tick
   * while recording, and a level meter that awaited a reply would tie the audio
   * loop to the main process's event loop.
   *
   * @param {{recording:boolean, you:number, them:number,
   *          title:string}} payload  you/them are 0..1 audio levels.
   */
  recordingState: (payload) => ipcRenderer.send('recording-state', payload),
  /** 'focus' | 'stop', raised by the floating indicator. */
  onIndicatorCommand: (cb) => subscribe('indicator-command', cb),
});
