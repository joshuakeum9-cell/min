# M0 — the spike

One week, no product code. M0 exists to find out whether this project should be
built at all, and to replace extrapolated numbers with measured ones.

**Run it on a weak machine.** 4 cores, 8 GB, no discrete GPU, with a video call
running for realism. A throttled VM is fine. Numbers from a developer desktop are
an upper bound and nothing more — `lib/hardware.js` will say so out loud.

## The gate

Two pass/fail bars, decided in advance so the result cannot be rationalised after
the fact:

| | Bar |
|---|---|
| **Quality** | ≥ 7 of 10 counterfactual pairs correctly identified by a blind reader |
| **Latency** | End-to-end note in under 6 minutes on the weak machine |

If quality fails, the architecture is not wrong but the default must flip: either
push more structure out of the prompt and into code, or make bring-your-own-key
the default and local the fallback. If latency fails, drop to Qwen3-1.7B
everywhere and re-measure.

Either way the point is to learn it in week one rather than month three.

## What each script answers

| Script | Question |
|---|---|
| `lib/hardware.js` | Is this machine a valid test bed? (It will usually say no.) |
| `lib/models.js` | Fetch and checksum-pin the models. ~4.6 GB for all four. |
| `capture-probe/` | Does loopback deliver continuous audio, or drop out during silence? |
| `probe-chunk-limit.js` | How much audio can the recogniser take before it aborts? |
| `bench-asr.js` | How long does an hour of audio take to transcribe, and at what memory? |
| `bench-llm.js` | Prefill and generation speed on CPU. The number nobody had measured. |
| `eval-counterfactual.js` | **The gate.** Is this enhancing notes or just summarising? |

## Order

```bash
npm install
node m0/lib/hardware.js                  # read the warnings, believe them
node m0/lib/models.js parakeet-v2 qwen3-4b qwen3-1.7b
```

**1. Capture integrity** — needs no meeting recording, run it now.

```bash
npm run m0:capture
```

Play audio through your speakers, press Start, pause the audio for the middle
third, resume. The probe reports whether the loopback track's frame count matches
the wall clock. A deficit means the raw WASAPI silence gap reaches the renderer
and buffer concatenation will desynchronise the two tracks.

**2. Chunk ceiling** — this is why the ASR pipeline is shaped the way it is.

```bash
node m0/probe-chunk-limit.js
```

Each duration runs in its own child process, because the failure mode is a native
abort that a try/catch cannot intercept.

**3. Throughput**

```bash
node m0/bench-asr.js --compare --synth 4     # identical audio, both models
node m0/bench-llm.js --compare               # both model tiers, CPU forced
```

**4. The gate** — needs real material.

```bash
node m0/eval-counterfactual.js --make-fixtures   # examples, so it runs today
node m0/eval-counterfactual.js generate
node m0/eval-counterfactual.js score
```

The bundled examples are short and clean; real meetings are neither, so a pass on
them is **not** a pass on the gate. Replace `fixtures/meetings/` with ten real
meetings — each a folder holding `transcript.md` and the `my-notes.md` you
actually typed at the time. Sloppy, fragmentary, half-finished notes are the
point. Tidying them up destroys the test.

Read the pairs without opening `_key.json`. Recruiting someone else to read them
is better still.

## Results

Every run writes a dated JSON into `results/`. Nothing is ever overwritten, so the
record of what was measured when survives.
