/**
 * Preload bridge for the meeting notification, the small window that appears in
 * the corner of the screen shortly before a calendar meeting starts, or when
 * another app has just opened the microphone for one.
 *
 * Its own bridge rather than preload.cjs, for the same reason the floating
 * indicator has one: that bridge hands the renderer the whole meetings library,
 * transcription and the settings file. This page shows a title and raises a
 * handful of commands, so it gets a surface with nothing else on it. A
 * compromised notification page cannot reach a meeting on disk, the calendar
 * address, or the record of which apps used the microphone.
 *
 * The title it renders is text from a remote ICS the user pasted, and the app
 * name is what main made of a registry key Windows wrote, so both cross this
 * boundary as strings and are written to the page with textContent. They are
 * data on both sides.
 *
 * CommonJS on purpose, same as the other two preloads: Electron preloads must be
 * .cjs when the package is "type": "module".
 */

const { contextBridge, ipcRenderer } = require('electron');

// The whole command vocabulary. Checked here as well as in main so a typo in
// notify.js fails silently at the source rather than reaching the main process
// as an unhandled string.
const COMMANDS = new Set(['take', 'dismiss', 'open', 'mute', 'settings', 'menu']);

contextBridge.exposeInMainWorld('notify', {
  /**
   * The card this notification is about, pushed by main. Two shapes: a calendar
   * meeting, which is any payload without a kind, or a detected one. The
   * callback never sees Electron's event object: handing that to page code
   * leaks `sender`, which can be used to reach back into the main process.
   *
   * @param {(m:{kind?:'meeting', title:string, start:string, end:string, startsInMs:number}
   *           | {kind:'detected', app:string, appKey:string}) => void} cb
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
   * closes the notification and does not ask again for this occurrence. The
   * next three are the detected card's menu: 'open' brings up the main window,
   * 'mute' stops notifications for the app named on the card, 'settings' opens
   * the notification settings. 'menu' is the page telling main the menu has
   * opened or closed, with the height the card now needs, so main can size the
   * window to it; it is the only command that carries a detail.
   *
   * The detail is forwarded as it is, null when there is none. Main reads it
   * as untrusted input from a page, the same as the command string.
   *
   * @param {'take'|'dismiss'|'open'|'mute'|'settings'|'menu'} command
   * @param {{open:boolean, height:number}|undefined} [detail]
   */
  send(command, detail) {
    if (!COMMANDS.has(command)) return false;
    ipcRenderer.send('notify-command', command, detail ?? null);
    return true;
  },
});
