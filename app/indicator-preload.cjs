/**
 * Preload bridge for the floating recording indicator, the small always-on-top
 * window that stays visible once the call app is in front of MIN.
 *
 * Its own bridge rather than preload.cjs: that one hands the renderer the whole
 * meetings library, transcription and the settings file. The indicator draws
 * four bars and raises three commands, so it gets a surface with nothing else on
 * it, and a compromised indicator page cannot reach a meeting on disk.
 *
 * CommonJS on purpose, same as preload.cjs: Electron preloads must be .cjs when
 * the package is "type": "module".
 */

const { contextBridge, ipcRenderer } = require('electron');

// The whole command vocabulary. Checked here as well as in main so a typo in
// indicator.js fails silently at the source rather than reaching the main
// process as an unhandled string.
const COMMANDS = new Set(['focus', 'stop']);

contextBridge.exposeInMainWorld('indicator', {
  /**
   * Latest recording state, pushed by main. The callback never sees Electron's
   * event object: handing that to page code leaks `sender`, which can be used to
   * reach back into the main process.
   *
   * @param {(state:{recording:boolean, you:number,
   *          them:number, title:string}) => void} cb
   * @returns {() => void} unsubscribe
   */
  onState(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('indicator-state', listener);
    return () => ipcRenderer.removeListener('indicator-state', listener);
  },

  /** @param {'focus'|'stop'} command */
  send(command) {
    if (!COMMANDS.has(command)) return false;
    ipcRenderer.send('indicator-command', command);
    return true;
  },

  /**
   * Move the window to a screen position, for the manual drag in indicator.js.
   *
   * Measured on Windows: -webkit-app-region:drag does nothing on a
   * focusable:false window, but the page still receives mousedown and mousemove
   * with real screen coordinates. Dragging is therefore done by hand, and
   * focusable stays false, which is what keeps a click off the user's call.
   *
   * Numbers only, and finite: this ends at setPosition, and NaN there throws
   * inside the main process.
   *
   * @param {number} x @param {number} y
   */
  moveTo(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    ipcRenderer.send('indicator-move', Math.round(x), Math.round(y));
    return true;
  },
});
