# Third-party licences

The `LICENSE` file at the root of this repository is MIT and covers **only the code
written for this project**: the source under `app/`, `m0/`, `mcp/`, `tools/` and
`docs/`. It does not cover any of the third-party components listed below, each of
which keeps its own licence. That includes the font files vendored into
`app/fonts/`, which sit inside this project's own directories but are not this
project's work.

This file exists because the Windows installer redistributes compiled native
libraries that carry licence obligations, and Apache-2.0 in particular requires the
licence text and any notices to travel with the binaries. As of version 1.0.0 the
installer ships those DLLs with no licence text beside them, so this document is the
attribution. There is no in-app notices screen yet.

Versions, binary names and install paths below were read off the 1.0.0 installer
tree and `package-lock.json` rather than recalled.

---

## Redistributed inside the Windows installer

### sherpa-onnx

- **What it does here:** the speech recognition runtime. Loads the Parakeet
  transducer, runs voice activity detection, and turns audio into timed tokens.
  This is the whole transcription engine.
- **Binaries shipped:** `sherpa-onnx-c-api.dll`, `sherpa-onnx-cxx-api.dll`,
  `sherpa-onnx.node`, plus the JavaScript bindings in `sherpa-onnx-node`.
  All of it lands in
  `resources/app.asar.unpacked/node_modules/sherpa-onnx-{node,win-x64}/`.
- **Version:** `sherpa-onnx-node` 1.13.7, `sherpa-onnx-win-x64` 1.13.7
- **Licence:** Apache License 2.0
- **Copyright:** Xiaomi Corporation. The upstream C and C++ sources that compile
  into these DLLs carry `Copyright (c) 2023 Xiaomi Corporation` in their file
  headers, and that is the notice Apache-2.0 requires to travel with the binaries.
  The npm packages `sherpa-onnx-node` and `sherpa-onnx-win-x64` give their author
  as "The next-gen Kaldi team", so both names are recorded here.
- **Source:** https://github.com/k2-fsa/sherpa-onnx
- **Licence text:** https://www.apache.org/licenses/LICENSE-2.0

Apache-2.0 section 4 requires that recipients of the binaries also receive a copy of
the licence and of any NOTICE file. Upstream ships the unmodified Apache-2.0 text
with the placeholder copyright line left blank and no NOTICE file, so the file
headers are the only notice there is to preserve. Treat this entry as that notice
until the licence text is copied into the installer itself.

### ONNX Runtime

- **What it does here:** the inference engine sherpa-onnx calls into. Every
  encoder, decoder and joiner pass goes through it.
- **Binaries shipped:** `onnxruntime.dll`, `onnxruntime_providers_shared.dll`,
  distributed inside the `sherpa-onnx-win-x64` package rather than installed
  directly by this project.
- **Licence:** MIT
- **Copyright:** Microsoft Corporation
- **Source:** https://github.com/microsoft/onnxruntime

### Electron

- **What it does here:** the desktop application shell. Provides the window, the
  renderer, the `desktopCapturer` and `getDisplayMedia` system-audio loopback
  grant, and the Node runtime the transcription pipeline executes in.
- **Version:** 44.1.1
- **Licence:** MIT
- **Copyright:** GitHub Inc. and Electron contributors
- **Source:** https://github.com/electron/electron

Electron bundles Chromium and Node.js, which carry their own licences. The
Chromium-derived libraries in the install directory are `d3dcompiler_47.dll`,
`dxcompiler.dll`, `dxil.dll`, `ffmpeg.dll`, `vk_swiftshader.dll` and `vulkan-1.dll`.
Their licences are enumerated in `LICENSES.chromium.html`, which electron-builder
already places next to `MIN.exe`, alongside `LICENSE.electron.txt`. Those two
files are the authoritative notice for the Electron and Chromium layer.

The note library uses SQLite through Node's built-in `node:sqlite` module, so no
separate SQLite binary is installed. SQLite itself is in the public domain
(https://www.sqlite.org/copyright.html) and reaches the app inside Node.js, which is
MIT licensed (https://github.com/nodejs/node).

### Model Context Protocol TypeScript SDK

- **What it does here:** implements the MCP server behind the `.mcpb` extension, so
  Claude Desktop can read the notes folder.
- **Version:** 1.30.0
- **Licence:** MIT
- **Copyright:** Anthropic, PBC
- **Source:** https://github.com/modelcontextprotocol/typescript-sdk

### Zod

- **What it does here:** validates the arguments coming into each MCP tool.
- **Version:** 4.5.4
- **Licence:** MIT
- **Copyright:** Colin McDonnell
- **Source:** https://github.com/colinhacks/zod

### elevate.exe

- **What it does here:** a helper the installer runs to relaunch itself with
  administrator rights, which a per-machine install or a silent update needs. It is
  installer plumbing, not app code. Nothing under `app/` calls it.
- **Binary shipped:** `resources/elevate.exe`. electron-builder copies it in from
  its own NSIS package, and the copy in the 1.0.0 build is byte-identical to the
  one in that package.
- **Copyright:** Johannes Passing. The binary's version resource gives CompanyName
  "Johannes Passing" and LegalCopyright "Copyright (C) 2007", and it carries the
  build path `C:\Dev\elevate\bin\x86\Release\Elevate.pdb`, matching the `Elevate`
  project in the repository below.
- **Source:** https://github.com/jpassing/elevate
- **Licence:** upstream is inconsistent and this entry does not pick a side for it.
  The repository root carries an MIT `LICENSE.md`, while the header comment in
  `Elevate/main.c` states the GNU Lesser General Public License 2.1 or later. Under
  either one, attribution is what a redistributor owes, and this entry is it.

### NSIS installer stub

- **What it does here:** the Windows setup .exe is an NSIS installer, so the NSIS
  exehead and its decompressor are compiled into that file. This is the code that
  runs before any of this project's code does, and it ships to every user who
  installs the app.
- **Binary shipped:** the stub embedded in the setup .exe. Its own application
  manifest names it `Nullsoft.NSIS.exehead`, "Nullsoft Install System v3.04". It
  comes from the NSIS 3.0.4.1 build electron-builder downloads.
- **Copyright:** Copyright (C) 1999-2018 Contributors, as stated in the `COPYING`
  file shipped in that NSIS build.
- **Licence:** zlib/libpng for NSIS itself, its plug-ins and its stubs. The
  compression modules are separate: zlib is zlib/libpng, bzip2 is the bzip2
  licence, and LZMA is the Common Public License 1.0. zlib/libpng says an
  acknowledgment in product documentation is appreciated rather than required,
  which is what this entry provides.
- **Source:** https://nsis.sourceforge.io

---

## Fonts bundled with the app

Both faces are vendored into `app/fonts/` as unmodified `.woff2` files, so they are
redistributed with the app rather than fetched from a font CDN at runtime. The full
licence text for both ships beside them at `app/fonts/OFL.txt`, which is what the
OFL requires.

### Archivo

- **What it does here:** the interface typeface, used for every text role except
  technical labels.
- **Licence:** SIL Open Font License 1.1
- **Copyright:** Copyright 2020 The Archivo Project Authors
- **Source:** https://github.com/Omnibus-Type/Archivo

### IBM Plex Mono

- **What it does here:** eyebrows, small-caps labels, timestamps and other
  technical text.
- **Licence:** SIL Open Font License 1.1
- **Copyright:** Copyright 2017 IBM Corp., with Reserved Font Name "Plex"
- **Source:** https://github.com/IBM/plex

The OFL requires that the licence accompany the font files, that they are not sold
on their own, and that a Reserved Font Name is not reused by a modified version.
Neither font is modified here, so "Plex" is not being reused as a name. Bundling
OFL fonts inside an application is explicitly permitted.

---

## Models downloaded at runtime

None of these are in the installer. The app fetches them on first use into a
writable per-user directory, verifies the byte count, and pins a SHA-256 in
`models/models.lock.json`. Their licences are not this project's licence.

A default install fetches exactly two things, Parakeet TDT 0.6B v3 and Silero VAD,
which come to 642 MiB. Running the transcriber with `--v2` fetches the English-only
v2 model as well, bringing a machine that has pulled both to 1.24 GiB. Those totals
are the sum of the byte counts in `m0/lib/models.js`, which is also what the app
verifies each file against.

The manifest in that file holds more than the app asks for. Its full contents come
to about 4.6 GB, but that figure includes two Qwen3 GGUF models the shipped app
never requests. Those are development-only benchmark artifacts and are listed under
"Development only" below.

### NVIDIA Parakeet TDT 0.6B (v3, and v2 behind a flag)

- **What it does here:** the speech recognition model itself. v3 is the default and
  covers 25 languages. v2 is English only and is selected with `--v2`.
- **Licence:** CC-BY-4.0. Attribution is required by anyone who redistributes or
  builds on the model, which is what this entry provides.
- **Copyright:** NVIDIA Corporation
- **Upstream model:** https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 and
  https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- **What is actually downloaded:** the int8 ONNX exports published for sherpa-onnx,
  pinned to an immutable commit:
  https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 and
  https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
- **Licence text:** https://creativecommons.org/licenses/by/4.0/legalcode

### Silero VAD v5

- **What it does here:** voice activity detection. Drops silence before it reaches
  the recogniser.
- **Licence:** MIT
- **Copyright:** Silero Team
- **Source:** https://github.com/snakers4/silero-vad
- **What is actually downloaded:** `silero_vad_v5.onnx` from the sherpa-onnx model
  release, https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models

---

## Development only, not redistributed

These appear in `package.json` or in the model manifest but are never installed on a
user's machine. They are listed so that reading the manifest does not raise a
question this file fails to answer.

- **node-llama-cpp** 3.20.0, MIT, https://github.com/withcatai/node-llama-cpp. A
  devDependency. It was used in the M0 benchmarks to measure local summarisation
  quality against the clipboard hand-off. The shipped app contains no local LLM.
- **electron-builder** 26.x, MIT, https://github.com/electron-userland/electron-builder.
  Builds the installer. Its own code is never installed, but two things it supplies
  are: `elevate.exe` and the NSIS stub, both listed above.
- **Qwen3 4B Instruct 2507 and Qwen3 1.7B (GGUF, Q4_K_M)**, Apache-2.0,
  https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF and
  https://huggingface.co/unsloth/Qwen3-1.7B-GGUF. Base models by the Qwen team at
  Alibaba Cloud, https://github.com/QwenLM/Qwen3. These are in the model manifest in
  `m0/lib/models.js` because the benchmark harness fetches them. The app never
  requests them.

---

## Reporting an error here

If a licence, copyright holder or URL on this page is wrong, that is a defect worth
an issue on https://github.com/joshuakeum9-cell/min. Getting attribution right
matters more than getting it quickly.
