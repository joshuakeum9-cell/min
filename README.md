# MIN

Meeting notes that never leave your machine. It records both sides of a call without a
bot joining, transcribes on your own CPU, and writes plain markdown into a folder you
own. No account, no API key, no subscription to this. First run downloads 642 MiB of
speech models; after that, recording and transcription work offline. The write-up is the
exception: the app hands your transcript and your typed notes to an assistant you
already pay for, by clipboard or by a Claude Desktop extension, and that is the only
point at which anything leaves your machine.

> **Measured:** throughput, the hard chunk ceiling, loopback continuity through silence,
> speech memory. All of it on one machine, the developer's desktop, which every
> `results/*.json` warns is not the target hardware: three of the four mark
> `"validTestBed": false`, and the fourth, the chunk-limit run, carries the same
> warnings without writing that field. Treat every figure below as an upper bound.
>
> **Not measured: the quality gate has never been run.** [`m0/README.md`](m0/README.md)
> sets it at 7 of 10 counterfactual pairs correctly identified by a blind reader, and
> `results/` contains no counterfactual run. So the claim this whole project rests on,
> that it fills in your notes rather than summarising the call, is unproven by its own
> test. The second gate, an end-to-end note in under 6 minutes, has not been run on the
> weak machine it specifies either.

## What makes it different

Most tools summarise the transcript, and a summary is generic because it was written by
something that wasn't in the room. This one starts from **your** notes: you type
fragments during the call, half sentences, a heading, a name with a question mark, and
the transcript is used to fill them out. The transcript is evidence, the structure is
yours, and two tracks that are never mixed tell the merge step which half of the
conversation was yours. `m0/eval-counterfactual.js` tests that claim by building two
notes from one transcript, one from your real notes and one from a *different meeting's*
notes, and asking a blind reader to tell them apart. If they can't, this is a summariser
in a costume. It has not been run against real meetings.

```
  microphone ─┐ you            two tracks, never mixed, so attribution needs
  loopback   ─┘ everyone else  no diarization model
      ▼ 16 kHz mono, one shared clock
  VAD-gated chunks ──► Parakeet TDT 0.6B (CPU) ──► transcript.md
      ▼ + the notes you typed (my-notes.md)
  prompt assembled locally (app/prompt.js)
      ▼ clipboard, or Claude Desktop over MCP (mcp/server.js)
  note.md, beside them in ~/Meetings/2026-09-02-vendor-sync/
```

**There is no local LLM.** The original design ran Qwen3-4B on the machine for the
write-up and `m0/bench-llm.js` killed it, for the reason in the table below. Handing the
prompt to a subscription you already pay for keeps the installer at about 118 MB rather
than 3 GB. `grep -rn "llama\|qwen" app/ mcp/` returns nothing, and `node-llama-cpp` is a
devDependency used only by the `m0/` benchmarks.

## Installing

Windows x64, from the
[latest release](https://github.com/joshuakeum9-cell/min/releases/latest):
`MIN-Setup.exe`, about 118 MB, which Windows Explorer will call 112 MB because it
counts in binary units. It installs for the current user only, so it never wants an
administrator password, and the models, Parakeet TDT 0.6B v3 and Silero VAD, arrive on
first launch. The filename carries no version, so this direct link keeps working across
releases:
`https://github.com/joshuakeum9-cell/min/releases/latest/download/MIN-Setup.exe`

```powershell
Get-FileHash "MIN-Setup.exe" -Algorithm SHA256
# 65ec8f3ec1b8cabbb8b432d63e2e3b218949a0ea7edfe8c189e307dd654c9a61, 117,918,600 bytes
```

That hash is published here and on the same release page as the file it describes, so it catches a
corrupted or truncated download but not a substituted one, and it is no substitute for a
code signature.

**Windows will warn you.** The installer is unsigned, because a code-signing certificate
costs money and this is a personal project given away for free. You will see a blue
"Windows protected your PC" screen: click **More info**, then **Run anyway**. Some
antivirus engines flag unsigned Electron installers too; a quarantine notice means a
heuristic fired, not that anything was found. If that trade is not one you want, build
`dist/MIN-Setup.exe` yourself with `npm install && npm run dist`.

**Getting the write-up back, two routes, no API key.** Pick Claude, ChatGPT, Gemini,
Copilot, Perplexity, Grok, Le Chat or DeepSeek: the app copies a ready-made prompt, opens
that site where you are already signed in, and you paste the answer back under Write-up.
It never sees a login, so there is no password or token to leak. Or install the Claude
Desktop extension, `dist/min.mcpb` from Releases, about 5 MB, and ask Claude for the
write-up: it reads the meeting off your disk and saves the note straight back into its
folder. Build it with `npm run mcpb`.

There is no "log in with ChatGPT" button because no such thing exists: ChatGPT Plus,
Claude Pro and Gemini Advanced are subscriptions to a website, with no API access and no
OAuth for third-party apps. Faking it means lifting your browser session cookie, which
all three providers prohibit and which gets accounts flagged. A local MCP server is the
sanctioned route.

## Measured, not assumed

| | |
|---|---|
| Speech, 30 s chunks | 9.8x realtime, CPU only, parakeet-v2. 30 s is what the app uses |
| Speech, end to end | 13.2x realtime (parakeet-v2) and 10.25x (parakeet-v3), so 4.6 and 5.9 minutes per hour of audio |
| Hard chunk ceiling | 398 s, a native abort a `try/catch` cannot intercept. Chunking is a requirement, not an optimisation, and recognition runs in a child process |
| Loopback during silence | Zero-filled, so the two tracks cannot drift apart |
| Speech memory | ~800 MiB peak |
| Local write-up on CPU | Abandoned. Qwen3-1.7B prefilled at 9.5 tokens/s, and a 2 038-token prompt exceeded a 150 s budget before generating anything |
| Storage, 1 000 hours | ~95 MB of transcripts, calculated from measured transcript sizes rather than measured directly |

**On which machine.** An AMD Ryzen 5 5600G, 6 physical cores, 15.3 GB RAM, Windows, Node 24,
CPU backend forced. `m0/lib/hardware.js` refuses to call that a valid test bed: every
`results/*.json` warns the desktop is roughly 1.5x faster than the median laptop, with
more RAM than the 8 GB target, and three of the four also carry `"validTestBed": false`,
the chunk-limit run being the one that does not write the field. So the honest headline
is about 10x to 13x realtime, roughly 4.5 to 6 minutes per hour of audio on that desktop,
and dividing by that 1.5x puts a 4-core laptop at roughly 7 to 9 minutes per hour.
Nothing has been re-run on the 4-core, 8 GB machine the gate calls for, and results land
in `results/` as dated JSON, never overwritten.

## Where your data lives, and how to delete it

Your meetings are plain markdown in `~/Meetings` (`C:\Users\<you>\Meetings`), the source
of truth and yours; audio is deleted once transcription succeeds. Everything else sits
outside it, in `%APPDATA%\MIN`, or `C:\Users\<you>\AppData\Roaming\MIN`.

| Path under `%APPDATA%\MIN` | What it holds |
|---|---|
| `index.db` | The search index, SQLite FTS5. Not a list of keywords: `app/library.js` writes the title, the notes you typed, the **full transcript** and the **full write-up** of every meeting into it as plaintext. A complete, readable, greppable duplicate of every meeting you have recorded, sitting outside your Meetings folder. |
| `mcp-index.db` | The Claude Desktop extension's own copy of that index, written by `mcp/server.js`, so with the extension installed this folder holds two full plaintext copies of every meeting. Separate file so the two processes never rebuild one database at the same time. |
| `models\` | The speech models, 642 MiB. |
| the rest | Electron's own GPU, network and cache directories. |

**Uninstalling removes none of it.** The installer is built with
`deleteAppDataOnUninstall: false`, so the indexes, the models and the caches survive an
uninstall. Delete them yourself:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\MIN"
```

That takes both indexes with it and costs you nothing: they are caches, rebuilt from the
markdown next time you search, and deleting `models\` only means the next transcription
downloads them again. On macOS and Linux the same directory is
`~/Library/Application Support/MIN` and `~/.config/MIN`; only Windows is tested.

## Running from source

```bash
npm install                                     # Node 24+
npm start                                       # the app
npm run m0                                      # the benchmarks
npm run m0:capture                              # needs a human: pause mid-recording
node m0/eval-counterfactual.js --make-fixtures  # needs a human: 10 real meetings
```

[`m0/README.md`](m0/README.md) has the spike detail and the gates. The benchmarks fetch a
development manifest, about 4.6 GB into `models/`: that figure includes the Qwen3 models
`m0/` measures and the shipped app never fetches, where a user's install downloads
642 MiB. Every model file has a SHA-256 that ships inside the app, in
`m0/lib/models.pins.json`, and each download is checked against its pin before the file
is used: a mismatch is refused, so a changed or substituted download is caught rather
than trusted. `rm -rf models node_modules fixtures/*.wav` frees about 5.9 GB. Keep
`results/` and `fixtures/meetings/`, the measurement record and your real transcripts,
and keep the repo out of OneDrive or any synced folder: sync locks cause build failures.

## Prior art

[`fastrepl/anarlog`](https://github.com/fastrepl/anarlog), formerly Hyprnote, is the
same idea, further along, and MIT licensed. It is Apple Silicon first: its local model
support is compiled out on x86_64, so on an ordinary Windows laptop it asks for Ollama,
an API key, or a subscription. That case is why this exists.

## Licence

The code here is MIT, see [`LICENSE`](LICENSE), and that covers only the code written
here. The Windows installer also redistributes third-party binaries, and the Apache-2.0
ones carry an attribution obligation the installer does not yet satisfy on its own.
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) is that attribution, and it also
covers the fonts vendored into `app/fonts/`. Models are fetched at runtime, not vendored:
Parakeet TDT 0.6B, CC-BY-4.0 (NVIDIA), and Silero VAD, MIT, plus Qwen3 (Apache-2.0) for
the `m0/` benchmarks only.
