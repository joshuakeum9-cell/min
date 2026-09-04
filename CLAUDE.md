# Taonim: context for Claude Code

A local-first meeting notes app. Captures both sides of a call with no bot joining,
transcribes on the user's own machine, saves plain markdown to a folder the user owns.
Open source, personal use first.

## The two constraints that decide every argument

1. **Zero recurring cost to run, forever.** No API bill that scales with users.
   Inference runs on the user's hardware. If a design needs a server someone has to
   operate, it is the wrong design.
2. **Redistributable.** Other people install it on their own PCs. Assume the median
   user has a 4-core, 8 GB, no-discrete-GPU laptop.

Every measurement in this file was taken on one reference test bed: a Ryzen 5 5600G
(an APU, so the iGPU shares memory bandwidth), 6 physical / 12 logical cores, with a
GTX 1660 SUPER and 15.3 GB of RAM. Every file in `results/` carries
`"validTestBed": false`. That box is roughly 1.5x the target machine, so its numbers
are a ceiling and **not** a valid benchmark result. `m0/lib/hardware.js` encodes this:
it detects the host, and refuses to certify a box that outclasses `TARGET_SPEC` as a
test bed. Nothing has been benchmarked on the 4-core / 8 GB target machine, and no
hour-long meeting has been run start to finish.

Builds are unsigned. Windows SmartScreen interrupts the first launch, and the README
documents the click-through. Anything that assumes a signed binary, such as silent or
managed installation, will not work.

## The product thesis, stated precisely

This is **not** a meeting summariser. The user types sloppy notes during the call;
the app uses the transcript to flesh out *their* structure and *their* judgment.
Their headings, their ordering, their words. If the output would be identical had
the user typed nothing, the feature has failed.

`m0/eval-counterfactual.js` exists to detect exactly that, and it is the largest
unproven claim in the project: the script is written, it has never been run against a
real meeting, and there is no result for it in `results/`. Treat the quality gate as
untested until there is one.

## Decided architecture

| Layer | Choice | Notes |
|---|---|---|
| Shell | Electron 44.1.1 + electron-builder 26 | Tauri's macOS webview has no `getDisplayMedia` |
| Capture | `getDisplayMedia` with `audio: 'loopback'` | **No native modules.** A 4x4 video request carries the audio track; `restrictOwnAudio` keeps our own output out |
| Tracks | Two, never mixed: mic and loopback | Free "me vs them" attribution, no diarization model |
| ASR | sherpa-onnx-node 1.13.7 + Parakeet TDT 0.6B int8 | v2 English-only, v3 25 languages. Ships VAD and diarization in-engine |
| Write-up | Clipboard hand-off (`app/prompt.js`), or the `.mcpb` extension for Claude Desktop (`mcp/server.js`) | **No LLM ships in the app.** `grep -rn qwen app/ mcp/` and `grep -rn llama app/ mcp/` both return nothing. `node-llama-cpp` is a devDependency, used only by the M0 benchmarks |
| Storage | Plain UTF-8 markdown, one dated folder per meeting under `~/Meetings` | **No compression, no database of record.** Both wavs are deleted once transcription succeeds; `--keep-audio` opts out |
| Search | `node:sqlite` FTS5, index in `userData`, never beside the meetings | Rebuilt from the markdown in about a second, so it is disposable, needs no migration story, and stays out of anything the user syncs |
| Ship | GitHub Releases, unsigned NSIS x64, built locally with `npm run dist` | No CI and no auto-update: `electron-updater` appears nowhere in the tree, so a new version means downloading the installer again. The mac and linux targets in `package.json` are configured but have never been built. Never Git LFS, it is metered |

## Hard-won facts, do not re-derive these

Several of these come from the M0 local-LLM investigation. That investigation is why
there is no local LLM in the shipped app. The findings stay here because the benchmarks
still run under `npm run m0`, and anyone who reopens the question will hit them again.

- **RESOLVED (measured 2026-09-02, real hardware): Chromium zero-fills the loopback
  track through silence.** The research called this "the highest-value unresolved
  measurement in the entire corpus": whether Windows' raw WASAPI silence gap reaches
  the renderer. It does not. In a 20 s recording where the system audio was completely
  silent, the loopback track still produced **19.82 s of samples and zero empty render
  blocks**, byte-for-byte the same count as the microphone track (both wavs 634,156 B).
  Consequences: **frame counts are a reliable clock, the two tracks stay sample-aligned
  for free, and no timestamp gap-reconstruction logic is needed.** Keep the device-change
  handler anyway. That is a different failure.
- **Capture startup costs ~0.3 s on a cold open, ~0.03 s warm, and does not accumulate.**
  Treat the deficit as a fixed offset, not drift.
- **System audio can exceed full scale** (peak 1.004-1.007 observed). The WAV encoder
  clamps to +/-1.0; do not assume input is already normalised.
- **Parakeet aborts on long audio.** The measured ceiling is **398 seconds, about 6.6
  minutes**. A 420 s chunk raises an onnxruntime broadcast error in an Add node. It is
  a **native abort, not a catchable exception**: a try/catch does not save the process.
  Two consequences: chunking is mandatory, and ASR must run in a child process. Peak
  RSS during ASR is about 800 MiB.
- **ASR throughput falls as chunks grow** (attention is quadratic). Parakeet v2 on 4
  CPU threads: **9.8x realtime at the 30 s chunk the app actually uses**, 9.99x at
  60 s, 8.2x at 120 s, 8.45x at 180 s, 7.2x at 240 s, 6.26x at 300 s, 5.6x at 360 s.
  Short chunks are faster *and* safer. Chunk at VAD silence boundaries, well below the
  ceiling.
- **The headline is about 10x to 13x realtime, roughly 4.5 to 6 minutes per hour of
  audio, on the reference bed.** End-to-end `bench-asr` measured 13.2x for parakeet-v2
  and 10.25x for v3, a projected 273 s and 351 s per hour of audio. Divide by the
  project's own 1.5x factor for a 4-core laptop: roughly 7 to 9 minutes per hour.
  **Do not claim 16x, and do not claim "about 4 minutes per hour."** The 14.82x behind
  those numbers was measured at a 15 s chunk, which the app does not use.
- **Models come from HuggingFace as individual files, not release tarballs.**
  bzip2-decompressing the 482 MB sherpa tarball costs >2 min of pinned CPU, cannot
  resume, and Windows' bundled bsdtar does not reliably handle bz2.
- **sherpa-onnx publishes Parakeet v3** (25 languages), not only v2. Earlier research
  concluded otherwise and was wrong.
- **Qwen3 is a hybrid THINKING model and reasons by default.** On CPU this is fatal:
  Qwen3-1.7B spent 34 s on a trivial prompt emitting 585 characters of invisible
  chain-of-thought and returned an **empty** answer. Fix:
  `new QwenChatWrapper({ thoughts: 'discourage' })`, which gave real output on the same
  prompt in 6.7 s. Qwen3-4B-**Instruct-2507** does not think by default, which is why it
  was the candidate. Every reasoning token is one the user waits for and never sees.
- **`threads: N` on `createContext` is only a HINT**: the real count drops when other
  evaluations run. Use `threads: { ideal: N, min: N }` to guarantee it.
- **This hardware class is memory-bandwidth bound and slower than the research assumed.**
  **The single-call local-LLM write-up does not meet the 6-minute gate on this class of
  machine**, and that result is what sent the write-up step to the clipboard. The
  6.1 tok/s generation figure this bullet used to quote matches no file under `results/`
  (the only 6.1 in the tree is a free-RAM line in a log), so it is gone, and so is the
  prefill-time arithmetic built on it. If you need throughput for the abandoned
  local-LLM experiment, read `results/bench-llm-*.json` and quote the model, backend and
  thread count alongside it.
- **node-llama-cpp ships CUDA and Vulkan prebuilts** for win-x64. Earlier research
  said there was no CUDA package. Force CPU for all M0 measurement anyway, and leave
  Vulkan **off**: it has open garbage-output bugs on Intel iGPUs, and fluent nonsense
  laundered into confident notes is worse than being slow.

## Packaging facts that only show up in the built app

The first two look fine under `npm start` and fail once installed.

- **`process.execPath` is the Electron binary, not node.** Spawning a `.js` file with
  it launches a second copy of the app. Pass `ELECTRON_RUN_AS_NODE: '1'` in the child's
  env, and rewrite `app.asar` to `app.asar.unpacked` in any path handed to `spawn`.
  Electron rewrites asar paths for `fs` calls automatically, but not for spawn arguments.
- **Electron forbids V8 external buffers.** sherpa-onnx returns them by default, so
  `readWave(path)` and `vad.front()` must be called as `readWave(path, false)` and
  `vad.front(false)`. Under plain `node` this costs one copy; in the packaged app,
  omitting it fails outright with `External buffers are not allowed`.
- **The installer must not carry `node-llama-cpp`.** Its CUDA and Vulkan binaries are
  ~530 MB and the shipped app never loads a local LLM: the write-up step hands a prompt
  to the clipboard. It belongs in devDependencies, which is where it now sits, and the
  M0 benchmarks still use it from there. The historical pre-CUDA-removal build that
  carried it was 378 MB. The current installer, `dist/Taonim-Setup.exe`, is about
  118 MB.

## Bleed suppression is load-bearing and deletes user data

`suppressBleed` drops transcript lines, so a false positive is silent data loss. Three
rules keep it safe, and all three were added after a review reproduced the failures:
a **five-word floor** (a bare "No." is trivially contained in any long sentence, and
deleting it turns a disagreement into consent), **real interval overlap** rather than
onset proximity, and **symmetric containment** in both directions. Suppressed lines are
persisted into `meeting.json` rather than discarded, because the audio is deleted in the
same run and would otherwise make a wrong call unrecoverable.

## The competitive situation

`fastrepl/anarlog` (launched as Hyprnote, YC-backed, MIT, ~9.2k stars, ships weekly)
is the same product. Read it. Its gap: `crates/local-llm-core/src/model.rs` gates
supported local models behind `#[cfg(target_arch = "aarch64")]`, so x86_64 Windows
gets no local LLM and is pushed to Ollama, an API key, or $15/month. That gap is the
opening, and it could close with one commit, so do not position solely on it.

Granola now has a free tier. "Undercuts $18/month" is not the pitch.

## Working rules

- **Never benchmark on the reference bed and call it a result.** `m0/lib/hardware.js`
  refuses to certify that box as a valid test bed; respect that. Force the CPU backend
  and cap threads to 4 to model the target machine.
- **Measure before believing.** Every performance number in the original research was
  an extrapolation. Several were wrong. Numbers live in `results/*.json`.
- **Constraints belong in code, not in the prompt.** A small model can hold four or
  five judgment instructions, not nine. Section titles come from the user's headings
  in code; heading format comes from a grammar; length caps come from truncation.
- Keep the ASR engine behind a narrow interface so models can be swapped.
- Write results, never overwrite them. Each run is a dated file.
