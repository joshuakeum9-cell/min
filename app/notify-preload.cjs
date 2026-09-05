/**
 * Preload bridge for the meeting notification, the small window that appears in
 * the corner of the screen shortly before a calendar meeting starts.
 *
 * Its own bridge rather than preload.cjs, for the same reason the floating
 * indicator has one: that bridge hands the renderer the whole meetings library,
 * transcription and the settings file. This page shows a title and raises two
 * commands, so it gets a surface with nothing else on it. A compromised
 * notification page cannot reach a meeting on disk or the calendar address.
 *
 * The title it renders is text from a remote ICS the user pasted, so it crosses
 * this boundary as a string and is written to the page with textContent. It is
 * data on both sides.
 *
 * CommonJS on purpose, same as the other two preloads: Electron preloads must be
 * .cjs when the package is "type": "module".
 */

const { contextBridge, ipcRenderer } = require('electron');

// The whole command vocabulary. Checked here as well as in main so a typo in
// notify.js fails silently at the source rather than reaching the main process
// as an unhandled string.
const COMMANDS = new Set(['take', 'dismiss']);

contextBridge.exposeInMainWorld('notify', {
  /**
   * The meeting this notification is about, pushed by main. The callback never
   * sees Electron's event object: handing that to page code leaks `sender`,
   * which can be used to reach back into the main process.
   *
   * @param {(m:{title:string, start:string, end:string, startsInMs:number}) => void} cb
   * @returns {() => void} unsubscribe
   */
  onMeeting(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('notify-meeting', listener);
    return () => ipcRenderer.removeListener('notify-meeting', listener);
  },

  /**
   * 'take' opens the note for this meeting and starts recording it; 'dismiss'
   * closes the notification and does not ask again for this occurrence.
   *
   * @param {'take'|'dismiss'} command
   */
  send(command) {
    if (!COMMANDS.has(command)) return false;
    ipcRenderer.send('notify-command', command);
    return true;
  },
});
