/**
 * Preload bridge. The renderer captures audio and owns the UI; everything that
 * touches disk goes through here, so the renderer keeps contextIsolation on and
 * never gets Node.
 *
 * CommonJS on purpose — Electron preloads must be .cjs when the package is
 * "type": "module".
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /**
   * @param {{startedAt:number, endedAt:number, title:string, notes:string,
   *          sampleRate:number, mic:Uint8Array, system:Uint8Array, timeline:object}} payload
   */
  saveMeeting: (payload) => ipcRenderer.invoke('save-meeting', payload),
  transcribe: (dir) => ipcRenderer.invoke('transcribe', dir),
  copyPrompt: (dir) => ipcRenderer.invoke('copy-prompt', dir),
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  readMeeting: (dir) => ipcRenderer.invoke('read-meeting', dir),
  search: (q) => ipcRenderer.invoke('search', q),
  saveNote: (dir, text) => ipcRenderer.invoke('save-note', dir, text),
  deleteMeeting: (dir) => ipcRenderer.invoke('delete-meeting', dir),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  modelsReady: () => ipcRenderer.invoke('models-ready'),
  meetingsDir: () => ipcRenderer.invoke('meetings-dir'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('set-always-on-top', on),
});
