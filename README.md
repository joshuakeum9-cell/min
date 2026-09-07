# MIN

Meeting notes that never leave your machine. It records both sides of a call without a
bot joining, transcribes on your own CPU, and writes plain markdown into a folder you
own. No account, no API key, no subscription to this. First run downloads 642 MiB of
speech models; after that, recording and transcription work offline.

Two things do use the network, and both are your choice. The write-up hands your
transcript and your typed notes to an assistant you already pay for, by clipboard or by a
Claude Desktop extension. And if you connect a calendar, MIN fetches that one address on a
timer so your upcoming meetings appear on Home and a note opened from one of them is
named after it. Nothing else is sent anywhere, and your notes and transcripts are never
uploaded.

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
prompt to a subscription you already pay for keeps the installer at about 117 MB rather
than 3 GB. `grep -rn "llama\|qwen" app/ mcp/` returns nothing, and `node-llama-cpp` is a
devDependency used only by the `m0/` benchmarks.

## What is on screen

**Home.** A rail down the left with Home, My notes and Settings. The column beside it
opens on "Coming up", the meetings on your calendar for the next 14 days, under a
row per day showing the date, the month and the weekday, with today marked by a dot and
anything already in progress kept at the top. Under that, your notes, grouped by the day
they were recorded and labelled Today, Yesterday, then the date. The search box
at the bottom, or Ctrl K from anywhere, searches titles, the notes you typed and the
full transcripts.

**Paging the agenda.** Five meetings at a time, with a back arrow, a forward arrow and a
Today button that appears once you have paged away from the first page. The paging counts
meetings rather than days, so the card is one height whether a day holds one meeting or
nine, and a fortnight of them never pushes your notes off the screen. Meetings that have
already finished are not listed.

**Moving a note to the trash.** Every note row carries a three-dots button, shown when
you hover the row or reach it with the keyboard, and its one item is "Move to trash". It
goes to the operating system's recycle bin, not to a deletion, so you can put it back
yourself from there. There is no confirmation dialog, on purpose: the recycle bin is the
confirmation, a line on Home names the meeting and says where it went, and a modal in
front of something this reversible is the kind of friction that trains people to click
through the dialogs that do matter.

**Connecting a calendar.** One field in Settings, and it is a secret iCal address, not a
sign-in. In Google Calendar the path is **Settings > your calendar > "Secret address in
iCal format"**. Paste that URL, press Test connection, and Home fills in. There is no
Google sign-in, no OAuth, no consent screen and no app verification, because MIN is only
an HTTPS client fetching one URL, and the same field takes an Outlook, iCloud or Fastmail
address. It must be `https`, and a `webcal://` link is that same address under another
scheme, so pasting one swaps the scheme for you and puts the rewritten address back in the
field where you can see it, rather than refusing it and making you do it. Refresh is every
5, 15 (the default), 30 or 60 minutes. That URL is a bearer credential, readable by anyone
who has it, so it is kept by the main process in the settings file rather than in the
renderer, and no error message or log ever prints it. Cancelled events are dropped. A feed
over 4 MB is refused, and nothing in Settings lifts that ceiling: a year of a busy Google
calendar is well under 1 MB, so a file that size is a runaway rather than a full diary.

**Which notes belong to a meeting.** "+ New note" is impromptu. It adopts no calendar
meeting, and pressing Record no longer attaches one either. **This is a change from
earlier versions**, where every recording took the title of whatever calendar event was
nearest in time, so a note started between two meetings came out named after one you were
not in. Granola draws the line in the same place: its New Note is for an ad-hoc meeting
or call that is not on your calendar, and notes made that way are not linked to the
calendar at all.

A note becomes a calendar note by being opened from the meeting instead. Click a meeting
in "Coming up" and a note opens for that meeting, carrying its title, its time and its
attendees, and saying so with a "From calendar" chip. The click does not start recording:
opening a meeting days early to jot down what you want out of it is the other half of
what that click is for, and a click that switched on the microphone would make that
unusable.

**The meeting prompt.** About a minute before a meeting on your calendar, a small card
appears in the top right corner of the screen naming it. Its "Take notes" button opens a
note for that meeting and starts recording, in one press. Dismissing it, or taking it, is
remembered for that occurrence, so it does not come back a minute later. It is on by
default, as "Prompt me when a meeting is about to start" under Settings > Recording, and
it needs a calendar connected.

It does not filter on how many people are invited. Granola treats a calendar entry as a
meeting only at two attendees or more; the person this was built for records university
lectures, which come off his feed with zero attendees or one, and that filter would make
the whole feature invisible to him. All-day events never prompt, because "Out of office"
is not a meeting to take notes in and an all-day item starts at midnight. A meeting that
started up to five minutes ago still prompts, so an app that was closed or asleep at the
lead moment does not silently miss the meeting you are already sitting in. And like the
floating pill, the card cannot take focus, which is the point of it while a call is
starting; the cost is that its X is the way out of it rather than Escape.

**Meeting detected.** The other prompt is for the meeting that is not on your calendar.
When another app opens your microphone, whether that is Zoom, Teams, Chrome running a call,
or anything else, a small strip appears in the top right corner saying "Meeting detected"
and naming the app, and its "Take notes" button starts a note and begins recording. A
chevron beside the button opens a short menu: Open MIN, Turn off notifications for that
app, and Change notification settings. MIN does not listen for any of this. Windows keeps
its own record of which programs have used the microphone and when, the record behind the
microphone icon in the system tray and the per-app activity it shows under Settings >
Privacy & security > Microphone, and MIN reads that record. It never opens the microphone to watch for a
meeting, so there is nothing to trust it with that you have not already trusted Windows
with. It also never fires while MIN is already recording: the microphone is in use then
because you pressed Record, and a card about it would be noise. Its own recordings and
Windows' own components, such as the Settings app testing your microphone, never count as
a meeting either.

Turning it off for one app is done from the card, and it stays off for that app only: a
Chrome that is playing a game with voice chat can be silenced without losing the card for
Teams. The apps you have muted are listed under Settings > In the background, each with an
"Allow again" button, and the whole feature is the switch above them, "Tell me when another
app starts using the microphone", on by default.

**Living in the tray.** A card that appears when a call starts is only useful if MIN is
running when the call starts, so MIN now starts when you sign in to Windows, hidden, with
an icon in the tray rather than a window on the screen, and closing its window hides it
back to the tray instead of quitting. Nothing is recorded or transcribed while it sits
there: it refreshes the calendar on its usual timer and reads the microphone record,
waiting for either to give it a reason to speak. Clicking the tray icon brings the window
back; to really quit, right-click it and choose Quit MIN. Starting at sign-in can be
switched off under Settings > In the background, where "Start MIN when I sign in to
Windows" is the first setting; closing to the tray is simply how the window closes, and
Quit is on the tray icon.

**The two-sided live transcript.** System audio on the left in grey, your microphone on
the right in green, because they are two separate recordings and not one mixed one. A
line appears when its speaker pauses, about a third of a second of silence, so a short
remark lands a second or two after it is said and a long unbroken stretch waits for the
10-second soft cap or the 20-second hard cap on a single utterance. Those lines are the
transcript: `transcript.md` is written from them, and nothing is run over the audio a
second time. On speakers rather than headphones the far end leaks into your microphone,
and a line that is the same words on both tracks, quieter on the copy that is the echo,
is dropped from the transcript rather than shown twice. It is not lost: every dropped
line is written into `meeting.json` under `echoesSuppressed`, with its text and the line
it echoed, so the decision can be checked afterwards. Live transcription can be turned
off in Settings, and then the transcript is written after you stop instead.

**Filler words** are dropped as the lines are written: standalone "uh", "um", "hm" and
"erm" only, and never inside a real word, so "umbrella" and "hummus" keep their letters
and "uh-huh" stays whole, because it is agreement and often the point of the sentence it
answers. This is parity rather than cleverness: commercial transcripts read clean because
their speech vendors strip disfluencies before anyone sees the text. It has its own
checkbox in Settings, and it applies to transcripts made from then on rather than
rewriting ones you already have. It may also do very little: Parakeet does not emit many
disfluencies to begin with, and that has not yet been measured against a real meeting.

**The transcript card.** It sits between your notes and the bottom bar, opened and closed
by the waveform button, and stays put while the notes scroll under it. Type in its search
box to filter to matching lines with the match highlighted, and click any line to copy it
as `[hh:mm:ss] Me: ...`, worded the way the bubble you clicked is worded rather than the
way the file is: `transcript.md`, and the Copy button that takes the whole transcript at
once, say `You:` instead. The footer carries the same Stop the bar does plus a line asking
you to get consent when transcribing others. That last one is not legal advice and does
not pretend to be. It is there because a tool that records other people should say so
where the recording is visible, not only in a settings page nobody opens.

**The audio is on disk before you stop.** A recording is written into its
folder as it happens, a few seconds at a time, rather than held in memory until
Stop. Two things follow. If the machine loses power, Windows forces a restart or
MIN is killed outright, the recording is not lost: the next launch finds the
part-written files, finishes them into a normal meeting and puts it in the list,
and the only thing missing is the few seconds since the last write. And a long
meeting no longer grows in memory, which is what a three-hour recording used to
do, about 1.3 GiB of it. The cost is that a meeting folder now exists from the
moment you press Record rather than from the moment you stop, and that if the
folder cannot be written to, Record refuses to start instead of failing at the
end. MIN also asks Windows not to sleep while a recording runs. The screen may
still turn off; the machine stays awake, because a laptop that sleeps mid-call
stops capturing and the meeting's own clock counts the sleep as recorded audio.

**Naming a note.** Type the title whenever you like: before recording, during, or after
you have stopped and come back to it a week later. It saves as you type, so Home shows the
new name the moment you go back to it. Until this version the title was written to disk
exactly once, at Stop, and anything typed after that was quietly lost. The folder on disk
keeps the name it was created with, which is why a renamed meeting can still sit in a folder
ending in `-untitled`: every list reads the title from `meeting.json`, never from the path.

**Stop and Resume.** Stop ends the capture, not the note. Press the button again, and the
recording carries on into the same note as another part of it, whether that is thirty
seconds or a day later. The button says Resume rather than Record whenever that is what
it will do, and "+ New note" is how you start a fresh one. This is a change from earlier
versions, where pressing Record with a note open silently started a second, unrelated
note.

Each part keeps its own audio, `mic-2.wav` and `system-2.wav` for the second, because a
resumed capture reopens the microphone and may come back at a different sample rate, and
because the gap between the parts is real time that no recording covers. The transcript
is one file with one clock running through it, so a line from the second part is stamped
where it was actually said. The note header then shows two numbers: the duration is the
audio that was actually captured, and the span is the wall-clock window it happened in. A
one-hour call stopped for a twenty-minute break is forty minutes of audio inside a
sixty-minute span, and both of those are worth knowing.

**The recording indicator.** In the note, one round waveform button beside Record, which is
also the bar's only level meter: grey and still when nothing is being captured, olive-green
and moving while it is, following whichever side of the conversation is louder, and
clicking it shows or hides the transcript. While a recording runs, a small pill also floats above
every other window, which is the case that matters, because the moment you switch to Zoom
or Teams every sign inside MIN is hidden. It shows itself only then: while MIN is the
window in front it hides, because an always-on-top pill covering the note it belongs to
is clutter. It carries four bars mixed left to right, the call at one end and your
microphone at the other, so it says who is talking without any labels, and beside them
an elapsed clock and a stop button. Clicking its face brings the note back, and it can be
dragged anywhere and remembers where. It is deliberately non-focusable, so it cannot take
focus off the call. It appears when a recording starts and is gone when one ends.

## Installing

Windows x64, from the
[latest release](https://github.com/joshuakeum9-cell/min/releases/latest):
`MIN-Setup.exe`, about 117 MB, which Windows Explorer will call 111 MB because it
counts in binary units. It installs for the current user only, so it never wants an
administrator password. The filename carries no version, so this direct link keeps working
across releases:
`https://github.com/joshuakeum9-cell/min/releases/latest/download/MIN-Setup.exe`

```powershell
Get-FileHash "MIN-Setup.exe" -Algorithm SHA256
# 989b19b8d8756e46aaa2bc6879751e2ba4802f5d3826f6eb18299bf48c07e1d5, 116,775,534 bytes
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

**Press Record once before you need it.** The speech models are not in the installer, so
`%APPDATA%\MIN\models` starts empty and Parakeet TDT 0.6B v3 and Silero VAD, 642 MiB
between them, are downloaded the first time you press Record, once and never again. With
live transcription switched off it is the first Write up instead. Either way that first
press is usually the moment a meeting is starting, which is the worst moment to wait for
642 MiB. Start a recording you do not need, on a connection you like, let the download
finish, then stop it. After that, recording and transcription work offline.

**Getting the write-up back, two routes, no API key.** Pick Claude, ChatGPT, Gemini,
Copilot, Perplexity, Grok, Le Chat or DeepSeek: the app copies a ready-made prompt, opens
that site where you are already signed in, and you paste the answer back under Write-up.
It never sees a login, so there is no password or token to leak. Or install the Claude
Desktop extension, `dist/min.mcpb` from Releases, about 5 MB, and ask Claude for the
write-up: it reads the meeting off your disk and saves the note straight back into its
folder. Build it with `npm run mcpb`.

**Asking Claude about a meeting while it is still happening.** The live transcript is
written into the meeting's folder as the meeting runs, a couple of seconds behind the
speech, and so are the notes you type. The extension lists a meeting that is being recorded
as "recording now" and, when asked to read it, returns what has been said and typed so far
and says so, so Claude Desktop can answer "what did she say about the deadline" during the
call and read again a minute later for the newer lines. That is the whole of MIN's live
assistant: no model of its own, no API, no bill, the subscription you already have reading a
file on your own disk. It is also why a crash mid-meeting now keeps the words as well as the
audio. Two limits worth knowing. The lines are grouped by speaker turn, the way the saved
transcript always has been, so a long stretch of one person talking is one growing paragraph
rather than a bubble per sentence. And Claude Desktop reads when asked; it does not watch the
file, so the question has to come from you.

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
of truth and yours. One folder per meeting:

| File | What it is |
|---|---|
| `my-notes.md` | What you typed, verbatim. Never rewritten by anything. |
| `transcript.md` | Every line that was said, with a timestamp and a speaker, written into the folder while the meeting is still running and finalised at Stop. One file however many times the meeting was stopped and resumed. |
| `note.md` | The write-up, once you paste one back. |
| `meeting.json` | Timings, devices, track integrity, and a record per part of whether its transcript is complete. |
| `mic.wav`, `system.wav` | Your microphone and everyone else, kept only until that part is transcribed. A resumed meeting adds `mic-2.wav` and `system-2.wav`, and so on. |

Audio is deleted once its transcription succeeds, and only then: a worker that crashed or
recognised nothing leaves the wavs where they are, because they are the only way to try
again. Everything else sits outside your Meetings folder, in `%APPDATA%\MIN`, or
`C:\Users\<you>\AppData\Roaming\MIN`.

| Path under `%APPDATA%\MIN` | What it holds |
|---|---|
| `index.db` | The search index, SQLite FTS5. Not a list of keywords: `app/library.js` writes the title, the notes you typed, the **full transcript** and the **full write-up** of every meeting into it as plaintext. A complete, readable, greppable duplicate of every meeting you have recorded, sitting outside your Meetings folder. |
| `mcp-index.db` | The Claude Desktop extension's own copy of that index, written by `mcp/server.js`, so with the extension installed this folder holds two full plaintext copies of every meeting. Separate file so the two processes never rebuild one database at the same time. |
| `settings.json` | Your settings, in plaintext, including the secret calendar address. Anyone who can read that file can read that calendar. |
| `settings.log` | Only exists if a save has ever failed. One line per failure, with the error code the operating system gave, because a settings pane can show that once and then lose it. If your calendar address keeps vanishing between launches, this file says why. On a machine running a third-party antivirus, the likeliest line is a blocked write from an unsigned program, and the fix is to add MIN-Notes.exe to that product's exceptions. |
| `calendar-cache.json` | The last calendar fetch, so Home still has an agenda offline. Plaintext meeting titles, times and attendees. |
| `capture.json`, `capture-mic.part.wav`, `capture-system.part.wav` | Only in a meeting folder, and only while a recording is running or after one was interrupted. The two part files are the real wavs being written into, with their length fields still zero; the marker holds the title, the start time and the sample rate so the recording can be finished without them. If you see these in a folder, that meeting was cut short and MIN will assemble it the next time it starts. |
| `live-transcript.log` | What the live transcription worker wrote to its error output, appended while a recording runs. A debugging aid rather than a feature: its size is checked once per launch and the file is thrown away if it has passed 256 KB, so a single long session can grow past that and is only trimmed the next time MIN starts, and every failure to write it is swallowed, because a log must never be the reason a meeting is lost. Before it existed, a worker that finished cleanly could be reported as a crash with nothing on disk to say otherwise. |
| `models\` | The speech models, 642 MiB. |
| the rest | Electron's own GPU, network and cache directories. |

On macOS and Linux the same directory is `~/Library/Application Support/MIN` and
`~/.config/MIN`; only Windows is tested.

## Uninstalling

Windows Settings > Apps removes the program. There is no "Uninstall MIN" entry in the
Start menu: the installer puts a shortcut to the app there, not to its uninstaller. It deliberately
leaves your data behind, both of these:

- `~/Meetings`, or `C:\Users\<you>\Meetings`. Your notes and transcripts, untouched.
  Destroying them on the way out is the one thing an uninstaller must never do.
- `%APPDATA%\MIN`, or `C:\Users\<you>\AppData\Roaming\MIN`. The indexes, the 642 MiB of
  models, the settings file with your calendar address in it, and Electron's caches. The
  installer is built with `deleteAppDataOnUninstall: false`, so all of it survives.

Remove either by hand when you want it gone:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\MIN"
```

That takes both indexes with it and costs you nothing: they are caches, rebuilt from the
markdown next time you search, and deleting `models\` only means the next transcription
downloads them again. `~/Meetings` is the one to think about before deleting, because
nothing rebuilds it.

**If a third-party uninstaller says "invalid uninstall command".** Revo Uninstaller and
tools like it cache the uninstall command from whenever they last scanned, rather than
reading the registry each time. The executable was renamed in 1.0.2, so an entry cached
before that points at a name that no longer exists and fails. Nothing is wrong with the
install: refresh that tool's list, or use Windows Settings > Apps, which reads the live
registry.

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
