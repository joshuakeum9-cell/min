# MIN design system

The values here are read out of the `:root` block and rules in `app/index.html`. If this file
and that file disagree, the stylesheet wins and this file gets corrected.

Scope is the application: two views, a header, a status strip, a dozen components. The
marketing page in `docs/index.html` reuses this palette and these two typefaces at a larger
scale, with one dark band and 12px cards. Its layout is not documented here.

## Principles

- Light canvas by default. Near-black ink, hairline rules, three tones of grey. `box-shadow`
  appears zero times in `app/index.html`.
- One accent. Coral `#f36458` fills exactly one surface, the Record button. Everywhere else it
  is a mark, not a fill: the brand dot, the on-top checkbox, the clock while a recording runs,
  the selected meeting row's left edge, the open detail tab's underline, and selected text. The
  rule is not "use coral sparingly", it is "coral means live or selected", and that only holds
  while nothing decorative borrows it.
- Mono is a labelling system, not a code face: timestamps, technical eyebrows, small-caps
  labels. Never prose.
- Application-scale radii, 3px to 6px, plus pills for the two commit actions, Record and Write
  up. A 12px corner on a 36px control eats a third of its height and reads as a card.
- Hierarchy comes from size and tracking, not weight contrast. Regular 400 for reading, medium
  500 for titles, semibold 600 only for uppercase micro-labels.
- A one-pixel border means interactive. `--hairline-strong` borders controls, `--hairline`
  borders structure. Giving a static panel the stronger border makes people click it.
- Inversion is the selected state. The active tab is not tinted, it is `--ink` filled with
  `--canvas` text. At 11px uppercase there is not enough surface for a subtle state.
- Every changing number sets `tabular-nums`. A clock that shifts width while it counts is
  distracting.

## Colours

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#ffffff` | Default background, the reading and writing surface |
| `--canvas-sunk` | `#f7f7f7` | The meetings list column |
| `--canvas-paper` | `#ededed` | Raised panels: inactive tabs, inline code, button and row hover |
| `--hairline` | `#ededed` | One-pixel structural rules. Same value as canvas-paper, kept a separate name because one is a fill and one is a border |
| `--hairline-strong` | `#dcdcdc` | The border of anything you can type into or click |
| `--ink` | `#0b0b0b` | Headings, titles, the wordmark, the "you" meter and speaker tag |
| `--ink-soft` | `#212121` | Body text |
| `--graphite` | `#353535` | Declared, referenced nowhere |
| `--mute` | `#797979` | Mono labels, meta lines, snippets, the status strip |
| `--ash` | `#b9b9b9` | Placeholders, transcript timestamps, list markers |
| `--slate` | `#3c4758` | Declared, referenced nowhere |
| `--slate-soft` | `#505b6c` | The "them" colour: their meter, their transcript lines, the transcribed pip |
| `--brand` | `#f36458` | The Record button fill, and the six marks listed above |
| `--brand-deep` | `#dd0000` | Declared, referenced nowhere. Same value as `--error` |
| `--success` | `#37cd84` | The "written up" pip. Used only as a 6px shape |
| `--error` | `#dd0000` | The status strip when something failed |
| `--link` | `#0052ef` | Inline links in a rendered write-up, and every focus ring |

The Record button paints ink on coral, not white. Ink on coral is 6.35:1, white on coral is
3.10:1. The dark label is why the button reads as a control rather than an advert.

### The dark band

The marketing page has one dark section. It is not a theme and there is no toggle: neither
stylesheet contains a `prefers-color-scheme` query. Five values re-tone, the accent does not.

| Role | Light | Dark |
|---|---|---|
| Page fill | `#ffffff` | `#0b0b0b` |
| Card fill | `#ededed` | `#212121` |
| Rules and borders | `#ededed` | `#353535` |
| Headings | `#0b0b0b` | `#ffffff` |
| Body | `#212121` | `#b9b9b9` |
| Accent | `#f36458` | `#f36458` |

### Contrast, measured against white

| Pair | Ratio | Verdict |
|---|---|---|
| `--ink` | 19.68:1 | passes everywhere |
| `--ink-soft` | 16.10:1 | passes everywhere |
| `--slate-soft` | 6.88:1 | passes everywhere |
| `--ink` on `--brand` | 6.35:1 | passes everywhere |
| `--link` | 6.08:1 | passes everywhere |
| `--mute` | 4.35:1 | short of 4.5:1 for small text |
| `#2a9d5c` | 3.46:1 | short of 4.5:1 at the 10.5px it is used at |
| `--brand` | 3.10:1 | surfaces and large text only, never body |
| `--ash` | 1.96:1 | fine as a placeholder, too low for timestamps |

Three open defects, not decisions:

- `--mute` carries most of the small mono labels. `#6e6e6e` would clear the threshold at
  5.10:1 without changing the feel.
- Transcript timestamps in `--ash` should move to `--mute`.
- `::selection` sets coral with `var(--canvas)` on top, which in the app is white on coral at
  3.10:1. Every other coral surface takes ink. This one should too.

## Typography

Two typefaces, both under the SIL Open Font License 1.1, both self-hosted in `app/fonts/` so a
launch makes no network request. The Content Security Policy sets `font-src 'self'`, so a
remote stylesheet would be blocked anyway. That is the correct outcome for an app whose claim
is that nothing leaves the machine. The licence text ships beside the files in
`app/fonts/OFL.txt`.

**Archivo** carries every reading role: titles, body, buttons, uppercase micro-labels.
One variable file, `archivo-latin-wght.woff2`, declared `font-weight: 100 900`, covers 400, 500
and 600 from a single download.

**IBM Plex Mono** is reserved for timestamps, meter labels, speaker tags, small-caps captions
and the status strip. Two files ship, 400 and 500, and every rule that sets it sets 400: the
500 file is downloaded and never used. In an app whose pitch is that the recording is exact,
mono on anything measured signals that the number came from the machine, not from a writer.

Both faces are declared `font-display: swap` and fall back to a system stack.

| Role | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|
| `title-detail` | 26px | 500 | 1.1 | -0.026em | Meeting title in the detail pane |
| `title-meeting` | 24px | 500 | 1.1 | -0.024em | The live meeting-title input |
| `doc-h2` | 21px | 500 | 1.13 | -0.02em | Top-level heading in a rendered write-up |
| `wordmark` | 19px | 500 | 1.0 | -0.019em | App wordmark |
| `doc-h3` | 17px | 500 | 1.13 | -0.02em | Second-level heading. h4 and h5 drop to 15px |
| `body-app` | 15px | 400 | 1.5 | 0 | App chrome, the default |
| `prose` | 15px | 400 | 1.62 | 0 | Rendered markdown in the detail pane |
| `notes` | 15px | 400 | 1.68 | 0 | The notes textarea |
| `row-title` | 14px | 500 | 1.3 | -0.014em | Meeting-list row titles |
| `field` | 14px | 400 | 1.5 | 0 | Search input. Transcript text and the detail textarea use 1.6 |
| `button-app` | 13px | 500 | 1.0 | -0.01em | App buttons. The small variant drops to 12px |
| `select` | 12.5px | 500 | 1.0 | 0 | The provider select |
| `snippet` | 11.5px | 400 | 1.5 | 0 | Search-result snippets |
| `caps-tab` | 11px | 600 | 1.0 | 0.06em | View tabs, uppercase. Detail tabs use 0.07em |
| `mono-clock` | 13px | 400 | 1.0 | 0 | The recording clock, tabular figures |
| `mono-status` | 10.5px | 400 | 1.5 | 0.03em | Status strip. The detail sub-line uses 0.05em, uppercase |
| `mono-timestamp` | 10.5px | 400 | 2.0 | 0 | Transcript timestamps, tabular figures |
| `mono-micro` | 10px | 400 | 1.0 to 2.1 | 0.02em to 0.1em | Meter labels and counts at 0.1em/1.0, speaker tags 0.08em/2.1, the on-top toggle 0.06em/1.5, row meta 0.02em/1.4 |

- **Tracking tightens as size grows.** 0 at body sizes, -0.02em in the low twenties, -0.026em
  at 26px. Archivo set large at default tracking reads as a row of separate letters rather than
  a phrase.
- **Weight 600 only for uppercase micro-labels.** Uppercase at 11px loses too much shape
  information at 500, so tab labels take 600 and 0.06em to 0.07em to reopen the counters.
- **Three body line heights, on purpose.** 1.5 for chrome, 1.62 for prose you read, 1.68 for
  the notes textarea you type into for an hour. Looser leading in a text area makes the cursor
  easier to find when your eyes are on the call rather than on the app.
- **Mono never sets prose.** If a run of mono is longer than about six words, it is in the
  wrong role.

## Spacing and shape

Base step is 4px. The notes view gutters at 16px throughout, and the header, transport, meters,
sheet and action rows all align to that one left edge.

| Step | Value | Use |
|---|---|---|
| `xxs` | 4px | Tab gap |
| `xs` | 8px | Wordmark gap, action row gap, the record dot |
| `sm` | 12px | Transport gap, row padding, transcript column gap |
| `md` | 16px | Notes view gutters, notes sheet padding, header and footer padding |
| `lg` | 20px | Meter gap, detail tab spacing, detail head top padding |

Two drifts: the meetings detail pane gutters at 22px rather than 20px, and the action row and
meeting rows pad at 14px. Both should fold into the scale the next time those panes are
touched.

| Radius | Value | Use |
|---|---|---|
| `--r-xs` | 3px | Text fields, the notes sheet, the detail textarea, inline code |
| `--r-sm` | 4px | View tab buttons |
| `--r-md` | 5px | Secondary buttons and the provider select |
| `--r-lg` | 6px | Declared, referenced nowhere |
| `--r-full` | 9999px | Pills, the brand dot, status pips |

Meters and level bars are square, with no token. The pill is a hierarchy signal, so it only
works while it stays scarce.

## Components

| Component | Fill | Text | Radius | Size | Border |
|---|---|---|---|---|---|
| `app-header` | `--canvas` | `--ink` | 0 | 56px tall, 16px gutters | 1px `--hairline` bottom |
| `wordmark` | inherit | `--ink` | none | 19px, 8px gap to the dot | none |
| `brand-dot` | `--brand` | none | full | 8px | none |
| `tab-button` | `--canvas-paper` | `--mute` | 4px | 32px tall, 12px padding | 1px transparent |
| `tab-button.on` | `--ink` | `--canvas` | 4px | 32px tall | none |
| `button` | `--canvas` | `--ink-soft` | 5px | 36px tall, 14px padding | 1px `--hairline-strong` |
| `button.primary` | `--ink` | `--canvas` | full | 38px tall, 18px padding | 1px `--ink` |
| `button.brand` | `--brand` | `--ink` at 600 | full | 38px tall, 18px padding | 1px `--brand` |
| `button.sm` | `--canvas` | `--ink-soft` | 5px | 30px tall, 11px padding, 12px type | 1px `--hairline-strong` |
| `title` input | transparent | `--ink` | 0 | 24px type | none |
| `clock` | none | `--mute`, `--brand` while live | none | 13px mono | none |
| `meter` | `--hairline` track | `--mute` label | 0 | 2px tall, width transitions 0.09s linear | none |
| `notes-sheet` | `--canvas` | `--ink-soft` | 3px | 16px padding, 15px/1.68 | 1px `--hairline-strong` |
| `text-field` | `--canvas` | `--ink-soft` | 3px | 38px tall, 12px padding | 1px `--hairline-strong` |
| `select` | `--canvas` | `--ink-soft` | 5px | 36px tall, 9px padding | 1px `--hairline-strong` |
| `meeting-list` | `--canvas-sunk` | none | 0 | 208px wide | 1px `--hairline` right |
| `meeting-row` | `--canvas-sunk` | `--ink` | 0 | 12px by 14px | 1px `--hairline` bottom, 2px transparent left |
| `meeting-row.on` | `--canvas` | `--ink` | 0 | 12px by 14px | 2px `--brand` left |
| `status-pip` | `--success`, `--slate-soft`, or empty | none | full | 6px | 1px `--ash` when empty |
| `detail-tab` | none | `--mute` | 0 | 10px by 2px padding | 2px transparent bottom |
| `detail-tab.on` | none | `--ink` | 0 | 10px by 2px padding | 2px `--brand` bottom |
| `transcript-line` | `--canvas` | `--ink-soft` | 0 | grid `64px 46px 1fr`, 12px gap | none |
| `app-footer` | `--canvas` | `--mute`, `--error`, `#2a9d5c` | 0 | 40px tall, 16px gutters | 1px `--hairline` top |

Behaviour the table does not carry:

- The Record button holds an 8px `currentColor` dot that pulses on a 1.3s ease-in-out loop
  while recording. It is the only animation in the app, and it is cancelled under
  `prefers-reduced-motion: reduce`.
- The notes sheet takes no focus ring. Focus moves its border to `--mute` and nothing else.
  That element is focused nearly the whole session, so a ring would become the loudest thing on
  screen. Text fields and the select do the same, because an outline outside a 3px radius sits
  awkwardly against the corner. Everything else paints `outline: 2px solid var(--link)` at 1px
  to 2px offset.
- A selected meeting row carries two signals at once, tone and accent: the row lifts to
  `--canvas`, matching the detail pane beside it, and its left border goes coral. That is what
  keeps selection readable in peripheral vision while you read the document.
- Status pips differ in shape as well as colour. A filled circle is written up or transcribed,
  an empty ring is neither.
- The transcript's fixed `64px 46px 1fr` columns keep the text edge straight down the page,
  which is what makes a long transcript skimmable. Speaker tags are `--ink` for you and
  `--slate-soft` for them, the same pairing as the level meters.
- The status strip is the app's only channel for transient messages. No toasts, no modals.
- The meeting title is a borderless input that looks like a heading until you click it, because
  naming a meeting should not feel like filling in a form.
- Rendered write-ups cap at `68ch`, transcripts at `76ch`, the empty state at `54ch`.

## Don't

- Don't add a shadow. There are none, and one would look imported.
- Don't introduce a second accent hue. A second colour makes colour ordinary and breaks "coral
  means live".
- Don't use `--brand` for body text. It is 3.10:1 on white.
- Don't add a toast, a modal, or a notification.
- Don't add a dark-mode toggle without doing it properly. The dark band is one section of
  marketing copy, not half a theme, and a toggle would leave most of the app's surfaces
  untested against `#0b0b0b`.

## Working on this system

1. Read the values out of `app/index.html` before changing anything here. Its tokens are in one
   `:root` block at the top of the file.
2. Reference token names, not hex values. If a value has no token, that is a signal it should
   get one.
3. Known drift worth folding in: `#f5766b` (Record hover), `#000` (primary button hover) and
   `#2a9d5c` (status strip on success) are inline literals rather than tokens;
   `--graphite`, `--slate`, `--brand-deep` and `--r-lg` are declared and referenced nowhere;
   the mono 500 weight ships and is never used; `::selection` paints white on coral where every
   other coral surface takes ink.
4. The app has no breakpoints, which is a decision rather than an omission. It is a window a
   user keeps small beside a call, so it is a flex column that works at any size: fixed 56px
   header, growing view, fixed 40px strip, `overflow: hidden` on the body, scrolling only in
   the inner panes.
5. Before adding a colour, check whether the thing you are marking is live or selected. If it is
   neither, it is grey.
