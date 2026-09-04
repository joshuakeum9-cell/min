# granola-local — context for Claude Code

A local-first meeting notes app. Captures both sides of a call with no bot joining,
transcribes and writes notes entirely on the user's machine, saves plain markdown
to a folder. Open source, personal-use-first, public repo as portfolio evidence.

## The two constraints that decide every argument

1. **Zero recurring cost to the developer, forever.** No API bill that scales with
   users. Inference runs on the user's hardware. If a design needs a server I
   operate, it is the wrong design.
2. **Redistributable.** Other people install it on their own PCs. Assume the median
   user has a 4-core, 8 GB, no-discrete-GPU laptop. My own machine (Ryzen 5 5600G,
   GTX 1660 SUPER, 15 GB) is roughly 1.5x that and is **not** a valid benchmark target.

Personal use comes first, so: **no code signing, no Apple Developer account, no
paid anything.** Unsigned builds with documented click-through instructions.

## The product thesis, stated precisely

This is **not** a meeting summariser. The user types sloppy notes during the call;
the app uses the transcript to flesh out *their* structure and *their* judgment.
Their headings, their ordering, their words. If the output would be identical had
the user typed nothing, the feature has failed — that is what `m0/eval-counterfactual.js`
exists to detect.

## Decided architecture

| Layer | Choice | Notes |
|---|---|---|
| Shell | Electron 44.1.1 + electron-builder 26 | Tauri's macOS webview has no `getDisplayMedia` |
| Capture | `getDisplayMedia` with `audio: 'loopback'` | **No native modules.** 4x4 video request carries the audio track; `restrictOwnAudio` keeps our own output out |
| Tracks | Two, never mixed — mic and loopback | Free "me vs them" attribution, no diarization model |
| ASR | sherpa-onnx-node 1.13.7 + Parakeet TDT 0.6B int8 | v2 English-only, v3 25 languages. Ships VAD and diarization in-engine |
| LLM | node-llama-cpp 3.20.0 + Qwen3-4B-Instruct-2507 Q4_K_M | 1.7B on 8 GB machines. Picked on hallucination rate, not release date |
| Storage | Plain UTF-8 markdown, dated folder per meeting | **No compression.** Audio deleted after transcription |
| Search | `node:sqlite` FTS5, index outside the synced folder | Rebuilds from markdown in ~1.4 s, so it is disposable |
| Ship | GitHub Releases + electron-updater, public repo | Free CI on all three OSes. Never Git LFS — it is metered |

## Hard-won facts — do not re-derive these

- **RESOLVED (measured 2026-09-02, real hardware): Chromium zero-fills the loopback
  track through silence.** The research called this "the highest-value unresolved
  measurement in the entire corpus" — whether Windows' raw WASAPI silence gap reaches
  the renderer. It does not. In a 20 s recording where the system audio was completely
  silent, the loopback track still produced **19.82 s of samples and zero empty render
  blocks**, byte-for-byte the same count as the microphone track (both wavs 634,156 B).
  Consequences: **frame counts are a reliable clock, the two tracks stay sample-aligned
  for free, and no timestamp gap-reconstruction logic is needed.** Keep the device-change
  handler anyway — that is a different failure.
- **Capture startup costs ~0.3 s on a cold open, ~0.03 s warm, and does not accumulate.**
  Treat the deficit as a fixed offset, not drift.
- **System audio can exceed full scale** (peak 1.004-1.007 observed). The WAV encoder
  clamps to +/-1.0; do not assume input is already normalised.
- **Parakeet aborts on long audio.** Past roughly 5-6 minutes the encoder raises an
  onnxruntime broadcast error in self-attention. It is a **native abort, not a
  catchable exception** — a try/catch does not save the process. Two consequences:
  chunking is mandatory, and ASR must run in a child process.
- **ASR throughput falls as chunks grow** (attention is quadratic): ~12x realtime at
  30 s, ~5.4x at 300 s on 4 CPU threads. Short chunks are faster *and* safer. Chunk
  at VAD silence boundaries, well below the ceiling.
- **Models come from HuggingFace as individual files, not release tarballs.**
  bzip2-decompressing the 482 MB sherpa tarball costs >2 min of pinned CPU, cannot
  resume, and Windows' bundled bsdtar does not reliably handle bz2.
- **sherpa-onnx publishes Parakeet v3** (25 languages), not only v2. Earlier research
  concluded otherwise and was wrong.
- **Qwen3 is a hybrid THINKING model and reasons by default.** On CPU this is fatal:
  Qwen3-1.7B spent 34 s on a trivial prompt emitting 585 characters of invisible
  chain-of-thought and returned an **empty** answer. Fix:
  `new QwenChatWrapper({ thoughts: 'discourage' })` — same prompt, 6.7 s, real output.
  Qwen3-4B-**Instruct-2507** does not think by default, which is part of why it is the
  pick. Every reasoning token is one the user waits for and never sees.
- **`threads: N` on `createContext` is only a HINT** — the real count drops when other
  evaluations run. Use `threads: { ideal: N, min: N }` to guarantee it.
- **This hardware class is memory-bandwidth bound and slower than the research assumed.**
  Measured on the 5600G (an APU, so the iGPU shares memory bandwidth): Qwen3-1.7B Q4_K_M
  runs at **6.1 tok/s generation, ~9.5 tok/s prefill** on CPU. Prefill being barely
  faster than generation is the signature of bandwidth saturation. A 13k-token meeting
  therefore needs ~23 minutes of prefill alone. **The single-call design does not meet
  the 6-minute gate on this class of machine.**
- **node-llama-cpp ships CUDA and Vulkan prebuilts** for win-x64. Earlier research
  said there was no CUDA package. Still force CPU for all M0 measurement, and ship
  with Vulkan **off** by default — it has open garbage-output bugs on Intel iGPUs,
  and fluent nonsense laundered into confident notes is worse than being slow.

## Packaging facts that only show up in the built app

Both of these look fine under `npm start` and fail once installed.

- **`process.execPath` is the Electron binary, not node.** Spawning a `.js` file with
  it launches a second copy of the app. Pass `ELECTRON_RUN_AS_NODE: '1'` in the child's
  env, and rewrite `app.asar` to `app.asar.unpacked` in any path handed to `spawn` —
  Electron rewrites asar paths for `fs` calls automatically, but not for spawn arguments.
- **Electron forbids V8 external buffers.** sherpa-onnx returns them by default, so
  `readWave(path)` and `vad.front()` must be called as `readWave(path, false)` and
  `vad.front(false)`. Under plain `node` this costs one copy; in the packaged app,
  omitting it fails outright with `External buffers are not allowed`.
- **The installer must not carry `node-llama-cpp`.** Its CUDA and Vulkan binaries are
  ~530 MB and the shipped app never loads a local LLM — job 3 hands a prompt to the
  clipboard. It belongs in devDependencies, where the M0 benchmarks still use it.
  Installer with it: 378 MB. Without: 111 MB.

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
wedge — and it could close with one commit, so do not position solely on it.

Granola now has a free tier. "Undercuts $18/month" is not the pitch.

## Working rules

- **Never benchmark on my machine and call it a result.** `m0/lib/hardware.js`
  refuses to call this box a valid test bed; respect that. Force the CPU backend and
  cap threads to 4 to model the target.
- **Measure before believing.** Every performance number in the original research was
  an extrapolation. Several were wrong. Numbers live in `results/*.json`.
- **Constraints belong in code, not in the prompt.** The 4B model can hold four or
  five judgment instructions, not nine. Section titles come from the user's headings
  in code; heading format comes from a grammar; length caps come from truncation.
- Keep the ASR engine behind a narrow interface so models can be swapped.
- Write results, never overwrite them — each run is a dated file.
