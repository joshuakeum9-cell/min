/**
 * MIN, one function: the renderer's audio frame, as it arrives over IPC in the
 * main process, turned into the Int16Array the live session wants.
 *
 * Its own module, with no imports, for a reason that bit once. main.js must
 * not import live.js at load time: live.js imports m0/lib/models.js, which
 * reads MIN_MODELS_DIR the moment it is evaluated, and ES module imports are
 * evaluated before the body of the module that imports them. A static import
 * of live.js from main.js therefore resolved the models directory before
 * main.js had pointed it at the user's app-data folder, so a packaged build
 * went looking for models inside the asar and failed with ENOTDIR, while the
 * development tree passed because the fallback happens to be the repo's own
 * models/. The packaged smoke test caught it. This file is the fix: main.js
 * can import it at load, and live.js re-exports it so the tests have one name.
 */

/**
 * Returns null for anything that is not a non-empty, even-length run of bytes.
 *
 * The renderer sends an ArrayBuffer. Electron's structured clone hands that to
 * main as an ArrayBuffer, not as a Uint8Array or a Buffer, and an ArrayBuffer
 * has no .buffer property. The handler used to do
 * `new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)`, which with
 * buf.buffer undefined is `new Int16Array(undefined, ...)`: not an exception,
 * an EMPTY Int16Array. Every frame therefore reached the worker as a
 * zero-length frame, and a zero-length frame is the protocol's end-of-track
 * signal. The worker flushed both tracks and finished, cleanly, within about
 * fifty milliseconds of loading its models, over and over, and no line of
 * live transcript was ever produced by the shipped app. This function exists
 * so that conversion is written once, handles every shape IPC can deliver,
 * and can be tested without Electron.
 *
 * A Buffer view can sit at an odd byte offset inside Node's pool, which the
 * Int16Array constructor rejects; those are copied to a fresh, aligned buffer.
 *
 * @param {ArrayBuffer|ArrayBufferView|unknown} buf
 * @returns {Int16Array|null}
 */
export function samplesFromIpc(buf) {
  let bytes;
  if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
  else if (buf && ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else return null;
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return null;
  if (bytes.byteOffset % 2 !== 0) bytes = bytes.slice();
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}
