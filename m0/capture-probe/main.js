/**
 * M0 capture-integrity probe.
 *
 * Answers the question the research could not resolve from documentation:
 * during silence, does Chromium's loopback capturer emit zero-filled frames, or
 * does it emit nothing at all (inheriting the raw WASAPI gap)?
 *
 * The answer decides whether the real app needs timestamp gap-reconstruction
 * logic, or whether frame counts can be trusted as a clock.
 *
 * This is a diagnostic tool, not shipped code. It runs with node integration on
 * so the renderer can write results directly. The real app will not do that.
 */

import { app, BrowserWindow, session, desktopCapturer, ipcMain } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, '../../results');

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 760,
    title: 'M0, capture integrity probe',
    backgroundColor: '#101312',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  // Grant loopback audio. Without an explicit handler, getDisplayMedia is
  // rejected outright in Electron.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({
        video: sources[0],
        // 'loopback'         , whole-system audio, including our own output
        // 'loopbackWithMute' , system audio with local playback muted
        audio: 'loopback',
      });
    },
    // useSystemPicker: false, we choose the source ourselves.
    { useSystemPicker: false }
  );

  win.loadFile(path.join(HERE, 'index.html'));
  return win;
}

ipcMain.handle('save-results', async (_evt, payload) => {
  await fsp.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RESULTS_DIR, `capture-probe-${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify(payload, null, 2) + '\n');
  return file;
});

ipcMain.handle('platform-info', () => ({
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
