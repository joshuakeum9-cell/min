# Taonim

Meeting notes that never leave your machine.

It records both sides of a call without a bot joining, and transcribes on your own
CPU. No account, no API key, no subscription to this. First run downloads 642 MiB of
speech models; after that, recording and transcription work offline. The write-up
step is different: the app assembles your transcript and your typed notes into a
prompt and hands it to an assistant you already pay for, either through the
clipboard or through a Claude Desktop extension. That step needs the internet, and
it is the only point at which anything leaves your machine. Notes are plain markdown
in a folder you own.

> **Status: recording, local transcription and the hand-off work end to end.** Record
> a meeting, transcribe it locally, click once, paste into whatever assistant you
> already pay for, get your write-up back.
>
> **Measured:** transcription throughput, the recogniser's hard chunk ceiling,
> loopback continuity through silence, speech memory. All of it on one machine, the
> developer's desktop, which `results/*.json` marks `"validTestBed": false`. Treat
> every figure below as an upper bound.
>
> **Not measured: the quality gate has never been run.**
> [`m0/README.md`](m0/README.md) sets it at 7 of 10 counterfactual pairs correctly
> identified by a blind reader, and `results/` contains no counterfactual run. So the
> claim this whole project rests on, that it fills in your notes rather than
> summarising the call, is currently unproven by its own test. The second gate, an
> end-to-end note in under 6 minutes, has not been run on the weak machine it
> specifies either.

## What makes it different from a meeting summariser

Most tools transcribe a call and summarise the transcript. The summary is
generic because it was written by something that wasn't in the room and doesn't
know what you cared about.

This one starts from **your** notes. You type fragments during the call, half
sentences, a heading, a name with a question mark, and the transcript is used to
fill them out. Your headings, your ordering, your words. The transcript is
evidence; the structure is yours.

That distinction is testable, and it is the first thing this project measures.
`m0/eval-counterfactual.js` builds two notes from the same transcript, one using
your real notes and one using a *different meeting's* notes, and asks a blind
reader to tell them apart. If they can't, the tool is a summariser wearing a
costume, and no amount of polish fixes that. That script has not been run against
real meetings yet, which is the open item at the top of this file.

## Design

```
  ┌─ microphone ────────────────┐
  │  you                        │
  ├─ system loopback ───────────┤   two tracks, never mixed
  │  everyone else on the call  │   → speaker attribution for free
  └──────────┬──────────────────┘
             │  16 kHz mono, one shared clock
             ▼
     VAD-gated chunks ──► Parakeet TDT 0.6B (CPU) ──► transcript.md
             │
             │  + the notes you typed (my-notes.md)
             ▼
     prompt assembled locally (app/prompt.js)
             │
             ├──► clipboard, then your provider's site ────┐   you paste
             │                                             │
             └──► Claude Desktop over MCP (mcp/server.js) ─┤   no pasting
                                                           ▼
                                                        note.md

   ~/Meetings/2026-09-02-vendor-sync/
       note.md · transcript.md · my-notes.md · meeting.json
```

No model runs in that last step. The app builds the prompt and moves text; the
write-up is produced by the assistant you already have, under your own account.
`grep -rn "llama\|qwen" app/ mcp/` returns nothing, and `node-llama-cpp` is a
devDependency used only by the `m0/` benchmarks.

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

**Speech recognition runs in a child process.** Not for responsiveness, but because
past about 6.6 minutes of audio the recogniser raises a native abort that a
`try/catch` cannot intercept. Chunking is a hard requirement, not an optimisation.
Throughput is about 1.8x better at 30-second chunks than at 6-minute ones because
attention is quadratic: on the desktop measured, parakeet-v2 ran at 9.8x realtime
at 30 s and 5.6x at 360 s.

**No model inside the app.** The original design ran Qwen3-4B locally for the
write-up. `m0/bench-llm.js` killed it: on the developer's desktop, which is faster
than the target machine, Qwen3-1.7B prefilled at 9.5 tokens per second, and a
2 038-token prompt blew a 150-second budget before generating anything. Real
transcripts are many times that length, so a local write-up could not come close to
the 6-minute bar. Handing the prompt to a subscription you already pay for was the
honest way out, and it means the installer is about 118 MB rather than 3 GB.

**Constraints live in code, not in the prompt.** Section titles come from your
headings by parsing, not by asking. Heading format comes from a grammar, length caps
come from truncation. What is left in `app/prompt.js` is only the part that needs
judgment. That discipline started as a workaround for a small local model, which can
hold four or five judgment instructions and not nine. The local model is gone and
the discipline stayed, because it is also what stops a large model quietly
reorganising your notes into its own shape.

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
| Speech, 30 s chunks | 9.8x realtime, CPU only, parakeet-v2. 30 s is what the app uses |
| Speech, end to end | 13.2x realtime (parakeet-v2) and 10.25x (parakeet-v3), so 4.6 and 5.9 minutes per hour of audio |
| Loopback during silence | Zero-filled, so the two tracks cannot drift apart |
| Hard chunk ceiling | 398 s, a native abort, uncatchable |
| Speech memory | ~800 MiB peak |
| Local write-up on CPU | Abandoned. Qwen3-1.7B prefilled at 9.5 tokens/s; 2 038 tokens exceeded a 150 s budget |
| Storage, 1 000 hours | ~95 MB, calculated from the measured transcript sizes rather than measured directly |

**Which machine.** All of the above ran on a Ryzen 5 5600G, 6 physical cores,
15.3 GB RAM, Windows, Node 24, CPU backend forced. `m0/lib/hardware.js` refuses to
call that a valid test bed: `results/*.json` carries `"validTestBed": false` and
warns that it is roughly 1.5x faster than the median laptop and has more RAM than
the 8 GB target. So the honest headline is about 10x to 13x realtime, roughly 4.5 to
6 minutes per hour of audio, on that desktop. Divide by the project's own 1.5x
factor and a 4-core laptop should expect roughly 7 to 9 minutes per hour. Nothing
here has been re-run on the 4-core, 8 GB machine the gate calls for.

Full results land in `results/` as dated JSON. Nothing is overwritten.

## Running the spike

Requires Node 24+. First run downloads the development manifest, about 4.6 GB of
models into `models/`, checksum-pinned on arrival. That figure is for the benchmarks
only: it includes the Qwen3 models `m0/` measures and the shipped app never fetches.
A default install of the app downloads 642 MiB.

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

Windows x64. Download `Taonim-Setup.exe` from the
[latest release](https://github.com/joshuakeum9-cell/taonim/releases/latest), about
118 MB. The filename carries no version, so this direct link keeps working across
releases:

```
https://github.com/joshuakeum9-cell/taonim/releases/latest/download/Taonim-Setup.exe
```

Windows Explorer will call the same file 112 MB, because it counts in binary units.

Check what you downloaded before running it:

```powershell
Get-FileHash "Taonim-Setup.exe" -Algorithm SHA256
```

`SHA-256: 02f38d2572c6ef1bcac74f73457c3a23fffc011f9f2466796922969fa629abf1`,
118,101,715 bytes.

It is a normal installer wizard, not a one-click one. It asks where to install, it
installs for the current user only so it never wants an administrator password, it
creates a desktop shortcut and a Start menu entry called Taonim, and it launches the
app when you click Finish.

**Windows will warn you.** The installer is unsigned, because a code-signing
certificate costs money and this is a personal project given away for free. You
will see a blue "Windows protected your PC" screen: click **More info**, then
**Run anyway**.

**Some antivirus engines will flag it as well.** An unsigned Electron installer that
unpacks several hundred files trips heuristic detection on a few engines, and a
quarantine notice means that heuristic fired, not that anything was found. If either
trade is not one you want to make, build it yourself with
`npm install && npm run dist` and run the installer you produced.

On first launch it downloads 642 MiB of speech models into your app-data folder,
Parakeet TDT 0.6B v3 and Silero VAD. That happens once, and afterwards recording and
transcription never need the internet again. The write-up step still does, because it
goes to your assistant.

Models are not bundled: they carry their own licences, and baking them in would make
every future update re-download the lot.

## Where your data lives, and how to delete it

Your meetings are plain markdown in `~/Meetings`, which on Windows is
`C:\Users\<you>\Meetings`. That folder is the source of truth and it is yours.

The app keeps its indexes, the models and Electron's caches outside it, all in
Electron's per-user app-data directory. On Windows that is `%APPDATA%\Taonim`, which
is `C:\Users\<you>\AppData\Roaming\Taonim`.

| Path | What it holds |
|---|---|
| `%APPDATA%\Taonim\index.db` | The search index, SQLite FTS5. It is not a list of keywords: `app/library.js` writes the title, the notes you typed, the **full transcript** and the **full write-up** of every meeting into it as plaintext. That makes it a complete, readable, greppable duplicate of every meeting you have recorded, sitting outside your Meetings folder. |
| `%APPDATA%\Taonim\mcp-index.db` | The Claude Desktop extension's own copy of that index, written by `mcp/server.js`. Same plaintext, separate file so the two processes never rebuild one database at the same time. |
| `%APPDATA%\Taonim\models\` | The speech models, 642 MiB. |
| `%APPDATA%\Taonim\` (rest) | Electron's own GPU, network and cache directories. |

So if you use the Claude Desktop extension there is a third full-text copy of every
meeting, and it sits in the same app-data folder as the first one. Earlier builds
wrote it to your system temp directory instead. `mcp/server.js` deletes that old
`taonim-mcp-index.db` from `%TEMP%` on startup if it finds one, so you do not have to
go looking for it.

**Uninstalling removes none of it.** The installer is built with
`deleteAppDataOnUninstall: false`, so the index, the models and the caches survive
an uninstall. Delete them yourself:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\Taonim"
```

That one command now takes both indexes with it. Deleting them costs you nothing.
They are caches and they are rebuilt from the markdown files the next time you
search. Deleting `models\` means the next transcription downloads them again.

On macOS and Linux the same directory is `~/Library/Application Support/Taonim` and
`~/.config/Taonim`. Only the Windows build has been tested.

## Running from source

Requires Node 24+.

```bash
npm install
npm start
```

## Letting your AI read the meetings directly

Two ways, neither of which needs an API key.

**Pick a provider (works with everything).** After a recording, choose Claude, ChatGPT,
Gemini, Copilot, Perplexity, Grok, Le Chat or DeepSeek from the dropdown. The app copies
a ready-made prompt and opens that site in your browser, where you are already signed in.
Paste, then paste the answer back under Write-up.

The app never sees a login. It has no password, no token, nothing to revoke, and nothing
to leak. Your browser already holds the session; the app just points at it.

**Or install the Claude Desktop extension (no pasting at all).** Download
`taonim.mcpb` from Releases and double-click it, or drag it onto the Claude Desktop
window. Then just ask:

> "Write up my 3pm call with the vendor."

Claude reads the meeting off your disk and saves the write-up straight back into its
folder. Nothing is uploaded beyond what Claude reads to answer you, and it runs on the
Claude subscription you already have. Claude Desktop ships its own Node runtime, so the
extension needs nothing installed.

Build it yourself with `npm run mcpb`.

### Why there is no "log in with ChatGPT" button

Because no such thing exists. ChatGPT Plus, Claude Pro and Gemini Advanced are
subscriptions to a website: they include no API access and expose no OAuth for third-party
apps. The only way to fake it is to lift your browser session cookie, which all three
providers prohibit and which gets accounts flagged. A local MCP server is the sanctioned
route, which is why it is the one this project takes.

## Cleaning up

This section is about the repository, not the installed app. For the installed app,
see [Where your data lives](#where-your-data-lives-and-how-to-delete-it) above.

Nothing here is precious except the source and `results/`. When you want the disk back:

| Path | Size | Safe to delete? |
|---|---|---|
| `models/` | 4.7 GB | Yes - `node m0/lib/models.js` re-downloads and re-verifies |
| `node_modules/` | 1.2 GB | Yes - `npm install` |
| `dist/` | 518 MB | Yes - `npm run dist` rebuilds it |
| `fixtures/*.wav` | ~19 MB | Yes - regenerated by `bench-asr.js --synth` |
| `fixtures/meetings/` | small | **Your real transcripts.** Git-ignored. Delete once the gate is done |
| `results/` | tiny | Keep - this is the measurement record |

```bash
rm -rf models node_modules fixtures/*.wav     # frees about 5.9 GB
rm -rf dist                                   # about 6.4 GB in total
```

**Keep this project out of OneDrive or any synced folder.** `models/` and
`node_modules/` will fill a cloud quota, and sync locks cause build failures.

## Prior art

[`fastrepl/anarlog`](https://github.com/fastrepl/anarlog) (formerly Hyprnote) is
the same idea, further along, MIT licensed, and worth reading. It is Apple
Silicon first, and its local model support is compiled out on x86_64, so on an
ordinary Windows laptop it asks you to install Ollama, bring an API key, or
subscribe. This project exists for that case: one installer, no setup, and, after a
one-time 642 MiB model download, recording plus transcription that run offline on a
machine with no graphics card.

## Licence

The code in this repository is MIT, see [`LICENSE`](LICENSE). It covers only the code
written here. The Windows installer also redistributes third-party binaries, and the
Apache-2.0 ones carry an attribution obligation the installer does not yet satisfy on
its own. [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) is that attribution, and
it also covers the fonts vendored into `app/fonts/`.

Models are fetched at runtime, not vendored, and carry their own terms. The app
downloads two: Parakeet TDT 0.6B, CC-BY-4.0 (NVIDIA), and Silero VAD, MIT. Qwen3
(Apache-2.0) is fetched only by the `m0/` benchmarks and is not part of the
installed app.
