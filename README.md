# granola-local

Meeting notes that never leave your machine.

It records both sides of a call without a bot joining, transcribes on your own
CPU, and uses your sloppy typed notes as the skeleton for a clean write-up. No
account, no API key, no subscription, no internet after first run. Notes are
plain markdown in a folder you own.

> **Status: the loop works.** Record a meeting, transcribe it locally, click once,
> paste into whatever assistant you already pay for, get your write-up. No account,
> no API key, no subscription to this. See [`m0/README.md`](m0/README.md) for the
> measurements the design is built on.

## What makes it different from a meeting summariser

Most tools transcribe a call and summarise the transcript. The summary is
generic because it was written by something that wasn't in the room and doesn't
know what you cared about.

This one starts from **your** notes. You type fragments during the call — half
sentences, a heading, a name with a question mark — and the transcript is used to
fill them out. Your headings, your ordering, your words. The transcript is
evidence; the structure is yours.

That distinction is testable, and it is the first thing this project measures.
`m0/eval-counterfactual.js` builds two notes from the same transcript, one using
your real notes and one using a *different meeting's* notes, and asks a blind
reader to tell them apart. If they can't, the tool is a summariser wearing a
costume, and no amount of polish fixes that.

## Design

```
  ┌─ microphone ────────────────┐
  │  you                        │
  ├─ system loopback ───────────┤   two tracks, never mixed
  │  everyone else on the call  │   → speaker attribution for free
  └──────────┬──────────────────┘
             │  16 kHz mono, one shared clock
             ▼
     VAD-gated chunks ──► Parakeet TDT 0.6B (CPU)  ──► transcript.md
             │
             │  + the notes you typed
             ▼
        Qwen3-4B (CPU) ──────────────────────────────► note.md
             │
             ▼
   ~/Meetings/2026-09-02-vendor-sync/
       note.md · transcript.md · my-notes.md · meeting.json
```

Audio is deleted once transcription succeeds. A thousand hours of meetings costs
about 95 MB on disk.

## Choices worth explaining

**Two audio tracks, never mixed.** Keeping the microphone and system audio
separate gives exact "me vs them" attribution with no diarization model. It also
means the transcript knows which half of the conversation was yours, which is
what the note-merge step actually needs.

**No native modules.** System audio comes from Electron's `getDisplayMedia` with
`audio: 'loopback'`. No node-gyp, no prebuild matrix, no compiler on the user's
machine.

**Speech recognition runs in a child process.** Not for responsiveness — because
past about 6.6 minutes of audio the recogniser raises a native abort that a
`try/catch` cannot intercept. Chunking is a hard requirement, not an
optimisation, and throughput is roughly 3x better at 30-second chunks than at
6-minute ones because attention is quadratic.

**Constraints live in code, not in the prompt.** A 4B model can hold four or five
judgment instructions, not nine. Section titles come from your headings by
parsing, heading format comes from a grammar, length caps come from truncation.
What's left for the model is the part that actually needs judgment.

**Plain files, no compression.** Compressing transcripts saves about 36 MB across
a thousand hours and costs you `grep`, Windows Search, Spotlight, readable diffs
and clean cloud-sync. The thing that actually costs gigabytes is audio, and the
answer there is to delete it.

## Measured, not assumed

Every number here came from `m0/` on real hardware. Several of them contradicted
the research that preceded them, which is the entire argument for building a
spike first.

| | |
|---|---|
| Speech, 30 s chunks | ~16x realtime, CPU only |
| Loopback during silence | Zero-filled — the two tracks cannot drift apart |
| Hard chunk ceiling | 398 s — a native abort, uncatchable |
| Speech memory | ~800 MiB steady state |
| Storage, 1 000 hours | ~95 MB |

Full results land in `results/` as dated JSON. Nothing is overwritten.

## Running the spike

Requires Node 24+. First run downloads ~4.6 GB of models into `models/`,
checksum-pinned on arrival.

```bash
npm install
npm run m0
```

Then the two parts that need a human:

```bash
npm run m0:capture                                # pause the audio mid-recording
node m0/eval-counterfactual.js --make-fixtures    # then use 10 real meetings
```

## Installing

Grab `granola-local Setup.exe` from Releases and run it.

**Windows will warn you.** The installer is unsigned, because a code-signing
certificate costs money and this is a personal project given away for free. You
will see a blue "Windows protected your PC" screen: click **More info**, then
**Run anyway**. If that trade is not one you want to make, build it yourself with
`npm install && npm run dist` and run the installer you produced.

On first launch it downloads about 640 MB of speech models into your app-data
folder. That happens once; after it, the app never needs the internet again.

Installer is ~111 MB. Models are not bundled: they carry their own licences, and
baking them in would make every future update re-download the lot.

## Running from source

Requires Node 24+.

```bash
npm install
npm start
```

## Cleaning up

Nothing here is precious except the source and `results/`. When you want the disk back:

| Path | Size | Safe to delete? |
|---|---|---|
| `models/` | 4.6 GB | Yes - `node m0/lib/models.js` re-downloads and re-verifies |
| `node_modules/` | 758 MB | Yes - `npm install` |
| `fixtures/*.wav` | ~19 MB | Yes - regenerated by `bench-asr.js --synth` |
| `fixtures/meetings/` | small | **Your real transcripts.** Git-ignored. Delete once the gate is done |
| `results/` | tiny | Keep - this is the measurement record |

```bash
rm -rf models node_modules fixtures/*.wav     # frees ~5.4 GB
```

**Keep this project out of OneDrive or any synced folder.** `models/` and
`node_modules/` will fill a cloud quota, and sync locks cause build failures.

## Prior art

[`fastrepl/anarlog`](https://github.com/fastrepl/anarlog) (formerly Hyprnote) is
the same idea, further along, MIT licensed, and worth reading. It is Apple
Silicon first — its local model support is compiled out on x86_64 — so on an
ordinary Windows laptop it asks you to install Ollama, bring an API key, or
subscribe. This project exists for that case: one installer, no setup, works
offline on a machine with no graphics card.

## Licence

Models are fetched at runtime, not vendored, and carry their own terms:
Parakeet TDT 0.6B is CC-BY-4.0 (NVIDIA), Qwen3 is Apache-2.0.
