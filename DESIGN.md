---
version: 1.0
name: Taonim-design-system
description: The design system for Taonim, a local-first meeting-notes desktop app and its one-page site. Light canvas by default, near-black ink, hairline rules instead of shadows, and a single coral accent that fills exactly two surfaces: the Record button in the app and the Download button on the site. Everywhere else coral is a mark rather than a fill: the brand dot, the on-top checkbox, the running clock, the selected meeting row, the open detail tab, selected text, and on the site the hero's emphasised word, the step numerals and the install list markers. Archivo (SIL OFL) carries every reading role; IBM Plex Mono (SIL OFL) is held back for timestamps, technical eyebrows and small-caps labels. Radii are application-scale (3px to 6px) in the app and 12px on the site's marketing cards. One dark band on the site is the only dark surface in the system. Values here are read out of app/index.html and docs/index.html, not aspirational.

colors:
  canvas: "#ffffff"
  canvas-sunk: "#f7f7f7"
  canvas-paper: "#ededed"
  hairline: "#ededed"
  hairline-strong: "#dcdcdc"
  ink: "#0b0b0b"
  ink-soft: "#212121"
  graphite: "#353535"
  mute: "#797979"
  ash: "#b9b9b9"
  slate: "#3c4758"
  slate-soft: "#505b6c"
  brand: "#f36458"
  brand-hover: "#f5766b"
  brand-deep: "#dd0000"
  success: "#37cd84"
  success-text: "#2a9d5c"
  error: "#dd0000"
  link: "#0052ef"
  link-on-dark: "#55beff"

colors-dark:
  canvas: "#0b0b0b"
  canvas-soft: "#212121"
  hairline: "#353535"
  ink: "#ffffff"
  body: "#b9b9b9"
  mute: "#797979"
  brand: "#f36458"

typography:
  display-hero:
    fontFamily: Archivo
    fontSize: clamp(46px, 8.4vw, 112px)
    fontWeight: 400
    lineHeight: 1.0
    letterSpacing: -0.04em
  display-section:
    fontFamily: Archivo
    fontSize: clamp(32px, 4.4vw, 48px)
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: -0.035em
  title-detail:
    fontFamily: Archivo
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.026em
  title-meeting:
    fontFamily: Archivo
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.024em
  doc-h2:
    fontFamily: Archivo
    fontSize: 21px
    fontWeight: 500
    lineHeight: 1.13
    letterSpacing: -0.02em
  lede:
    fontFamily: Archivo
    fontSize: clamp(17px, 2vw, 20px)
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.01em
  heading-card:
    fontFamily: Archivo
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: -0.02em
  wordmark:
    fontFamily: Archivo
    fontSize: 19px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: -0.019em
  doc-h3:
    fontFamily: Archivo
    fontSize: 17px
    fontWeight: 500
    lineHeight: 1.13
    letterSpacing: -0.02em
  body:
    fontFamily: Archivo
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-app:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  prose:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.62
  notes:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.68
  row-title:
    fontFamily: Archivo
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: -0.014em
  snippet:
    fontFamily: Archivo
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: Archivo
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.0
  button-app:
    fontFamily: Archivo
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: -0.01em
  caps-tab:
    fontFamily: Archivo
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.0
    letterSpacing: 0.06em
    textTransform: uppercase
  mono-eyebrow:
    fontFamily: IBM Plex Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.02em
  mono-caps:
    fontFamily: IBM Plex Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.1em
    textTransform: uppercase
  mono-foot:
    fontFamily: IBM Plex Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  mono-note:
    fontFamily: IBM Plex Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  mono-status:
    fontFamily: IBM Plex Mono
    fontSize: 10.5px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.03em
  mono-timestamp:
    fontFamily: IBM Plex Mono
    fontSize: 10.5px
    fontWeight: 400
    lineHeight: 2.0
    fontVariantNumeric: tabular-nums
  mono-micro:
    fontFamily: IBM Plex Mono
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.0
    letterSpacing: 0.1em
    textTransform: uppercase

rounded:
  none: 0px
  xs: 3px
  sm: 4px
  md: 5px
  lg: 6px
  card: 12px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 20px
  xl: 32px
  xxl: 44px
  section: 64px
  section-lg: 88px

components:
  wordmark:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.wordmark}"
    gap: 8px
  brand-dot:
    backgroundColor: "{colors.brand}"
    rounded: "{rounded.full}"
    size: 8px
  app-header:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    height: 56px
    padding: 16px
    border: "1px {colors.hairline}"
  app-footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.mute}"
    typography: "{typography.mono-status}"
    height: 40px
    padding: 16px
  tab-button:
    backgroundColor: "{colors.canvas-paper}"
    textColor: "{colors.mute}"
    typography: "{typography.caps-tab}"
    rounded: "{rounded.sm}"
    padding: 12px
    height: 32px
  tab-button-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.caps-tab}"
    rounded: "{rounded.sm}"
    padding: 12px
    height: 32px
  button:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.button-app}"
    rounded: "{rounded.md}"
    padding: 14px
    height: 36px
    border: "1px {colors.hairline-strong}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.button-app}"
    rounded: "{rounded.full}"
    padding: 18px
    height: 38px
  button-record:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.ink}"
    typography: "{typography.button-app}"
    fontWeight: 600
    rounded: "{rounded.full}"
    padding: 18px
    height: 38px
  button-sm:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.button-app}"
    fontSize: 12px
    rounded: "{rounded.md}"
    padding: 11px
    height: 30px
  site-button-brand:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: 22px
    height: 44px
  site-button-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: 22px
    height: 44px
  site-button-ghost:
    backgroundColor: transparent
    textColor: "{colors.ink-soft}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    padding: 22px
    height: 44px
    border: "1px {colors.hairline-strong}"
  text-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body-app}"
    fontSize: 14px
    rounded: "{rounded.xs}"
    padding: 12px
    height: 38px
    border: "1px {colors.hairline-strong}"
  notes-sheet:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.notes}"
    rounded: "{rounded.xs}"
    padding: 16px
    border: "1px {colors.hairline-strong}"
  select:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.button-app}"
    fontSize: 12.5px
    letterSpacing: 0
    rounded: "{rounded.md}"
    padding: 9px
    height: 36px
    border: "1px {colors.hairline-strong}"
  meter:
    backgroundColor: "{colors.hairline}"
    textColor: "{colors.mute}"
    typography: "{typography.mono-micro}"
    height: 2px
  meeting-list:
    backgroundColor: "{colors.canvas-sunk}"
    width: 208px
    border: "1px {colors.hairline}"
  meeting-row:
    backgroundColor: "{colors.canvas-sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.row-title}"
    padding: 12px
    border: "1px {colors.hairline}"
  meeting-row-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.row-title}"
    padding: 12px
    borderLeft: "2px {colors.brand}"
  status-pip:
    rounded: "{rounded.full}"
    size: 6px
  detail-tab:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.mute}"
    typography: "{typography.caps-tab}"
    padding: 10px
    borderBottom: "2px transparent"
  detail-tab-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.caps-tab}"
    padding: 10px
    borderBottom: "2px {colors.brand}"
  transcript-line:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.mono-timestamp}"
    columns: "64px 46px 1fr"
    gap: 12px
  card:
    backgroundColor: "{colors.canvas-paper}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body-app}"
    rounded: "{rounded.card}"
    padding: 32px
    border: "1px {colors.hairline}"
  card-on-dark:
    backgroundColor: "{colors-dark.canvas-soft}"
    textColor: "{colors-dark.body}"
    typography: "{typography.body-app}"
    rounded: "{rounded.card}"
    padding: 32px
    border: "1px {colors-dark.hairline}"
  callout:
    backgroundColor: "{colors.canvas-paper}"
    textColor: "{colors.ink-soft}"
    fontSize: 14.5px
    rounded: "{rounded.lg}"
    padding: 20px
    border: "1px {colors.hairline}"
  spec-table-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body-app}"
    padding: 16px
    border: "1px {colors.hairline}"
  site-nav:
    backgroundColor: "rgba(255,255,255,.92)"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body-app}"
    height: 64px
    border: "1px {colors.hairline}"
  site-section:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    padding: 88px
  band-dark:
    backgroundColor: "{colors-dark.canvas}"
    textColor: "{colors-dark.body}"
    typography: "{typography.body}"
    padding: 88px
  site-footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.mute}"
    typography: "{typography.mono-foot}"
    padding: 56px
    border: "1px {colors.hairline}"
---

## Overview

Taonim is a desktop app that sits above a video call while you type, then turns your notes
into a write-up. The interface is a work surface, not a brochure, and the design follows from
that: a white canvas, near-black text, hairline rules, and almost no colour. Anything with
personality in it would be in the way of a person taking notes in real time.

The system covers two surfaces that share one set of tokens. The application
(`app/index.html`) is a 56px header, a notes pane, and a meetings library, all on
`{colors.canvas}` white at 15px. The one-page site (`docs/index.html`) is the same palette and
the same two typefaces at marketing scale: a 112px hero, 88px section rhythm, 12px cards. A
reader who opens the app after seeing the site should recognise it immediately, which is the
whole reason the site does not have a separate brand.

There is exactly one accent, coral `{colors.brand}` `#f36458`, and it fills exactly two
surfaces: the Record button in the app and the Download button on the site, which are the same
action in two places. Every other appearance is a mark rather than a fill. The app has six: the
brand dot beside the wordmark, the always-on-top checkbox, the clock while a recording runs,
the 2px left edge of the selected meeting, the 2px underline of the open detail tab, and the
background of selected text. The site has five: the brand dot, the emphasised word in the hero,
the numerals on the step cards, the markers on the install list, and selected text. The rule is
not "use coral sparingly" but "coral means live or selected", and that only works if nothing
decorative ever borrows it.

Two of the site's marks bend that rule: the hero's emphasised word and the step numerals are
emphasis, not state. Both are on the marketing page rather than in the product, which is the
only reason they are tolerated. Nothing in the app is allowed the same licence.

The visual language is influenced by contemporary editorial software design in general:
oversized regular-weight display type with tight negative tracking, a monospace face used as
a labelling system rather than for code, and hairline rules doing the work that drop shadows
usually do. None of it is copied from a particular product.

**Key characteristics**

- Light canvas everywhere. The single dark surface in the whole system is one band on the site.
- No shadows at all. Depth comes from three tones of grey and one-pixel rules. `box-shadow`
  appears zero times in both stylesheets.
- Two open-licence typefaces: Archivo for every reading role, IBM Plex Mono for timestamps,
  eyebrows and small-caps labels.
- Application-scale radii of 3px to 6px in the app, 12px on the site's cards. The app is
  deliberately squarer than the site because it is a tool.
- Regular weight (400) for display, medium (500) for titles, semibold (600) only for
  uppercase micro-labels. Hierarchy comes from size and tracking, not from weight contrast.
- Every mono element that shows a number uses `tabular-nums`, because a clock that shifts
  width while it counts is distracting.

## Colours

### Brand and accent

- **Brand** (`{colors.brand}`, `#f36458`): the only chromatic colour in the system. It is a
  fill on two controls, the Record button and the Download button. Its other uses are marks:
  the brand dot, the always-on-top checkbox, the recording clock, the selected meeting row's
  left edge, the open detail tab's underline, selected text, and on the site the hero's
  emphasised word, the step numerals and the install list markers. Coral on white measures
  3.10:1, which is enough for a button surface and not enough for body text, so it is never
  used for running copy.
- **Brand hover** (`{colors.brand-hover}`, `#f5766b`): the lifted coral on button hover. Note
  this is currently an inline literal in both stylesheets rather than a declared variable.
- **Brand deep** (`{colors.brand-deep}`, `#dd0000`): declared in the app and identical in value
  to `{colors.error}`. It is the destructive and error red, never a brand surface.

The Record button paints `{colors.ink}` text on coral, not white. Ink on coral measures 6.35:1;
white on coral would be 3.10:1. The dark label is the reason the button reads as a control
rather than as an advert.

Selected text is the one place that breaks. Both stylesheets set `::selection` to coral with
`var(--canvas)` on top, and because the site's `--canvas` is the dark band while the app's is
white, the site gets ink on coral and the app gets white on coral at 3.10:1. That is a token
naming collision, not a decision, and the app's rule should be changed to `{colors.ink}`.

### Surface

- **Canvas** (`{colors.canvas}`, `#ffffff`): the default background of both the app and the
  site body.
- **Canvas sunk** (`{colors.canvas-sunk}`, `#f7f7f7`): the meetings list column. A half-tone
  recession is enough to separate a navigation column from the document beside it, so nothing
  heavier is used.
- **Canvas paper** (`{colors.canvas-paper}`, `#ededed`): raised panels. Inactive app tabs,
  inline code spans, site cards, step cards, and the unsigned-installer callout.
- **Hairline** (`{colors.hairline}`, `#ededed`): one-pixel structural rules. Same value as
  canvas-paper, kept as a separate name because one is a fill and one is a border, and they
  will not always move together.
- **Hairline strong** (`{colors.hairline-strong}`, `#dcdcdc`): the border of anything you can
  type into or click. A control needs a visible edge before you hover it; a section divider
  does not.

### Text

- **Ink** (`{colors.ink}`, `#0b0b0b`): headings, titles, the wordmark, emphasised words inside
  body text. 19.7:1 on white.
- **Ink soft** (`{colors.ink-soft}`, `#212121`): default body text on both surfaces. 16.1:1.
- **Graphite** (`{colors.graphite}`, `#353535`): declared in the app stylesheet and referenced
  nowhere in it. The site does not declare this name, but it declares the same value as
  `--hairline-soft` and uses it for the dark band's card borders. The value is in use; the name
  is not.
- **Mute** (`{colors.mute}`, `#797979`): mono labels, meta lines, footer links, the status
  strip. 4.35:1.
- **Ash** (`{colors.ash}`, `#b9b9b9`): placeholders, transcript timestamps, list markers.
  1.96:1, which is deliberate for placeholder text and a known problem for timestamps.
- **Slate** (`{colors.slate}`, `#3c4758`): declared in the app stylesheet, referenced nowhere,
  and not declared on the site at all.
- **Slate soft** (`{colors.slate-soft}`, `#505b6c`): the "them" colour. It marks the other
  speaker's level meter, their transcript lines, and the transcribed-not-yet-written-up pip.
  Cool blue-grey rather than a second hue, because speaker attribution is structural
  information and not a category to be colour-coded.

### Semantic

- **Success** (`{colors.success}`, `#37cd84`): the filled pip meaning "written up". Used only
  as a 6px shape.
- **Success text** (`{colors.success-text}`, `#2a9d5c`): the darker green for status-strip
  text, because the pip green is unreadable as type on white. Like brand hover, it is an inline
  literal in the app rather than a declared variable.
- **Error** (`{colors.error}`, `#dd0000`): the status strip when something failed.
- **Link** (`{colors.link}`, `#0052ef`): inline links and every focus ring in the app.
- **Link on dark** (`{colors.link-on-dark}`, `#55beff`): the site's focus-ring colour, chosen
  so the ring survives the dark band.

### The dark band set

The site has one dark section, the "why it is built this way" band. It is not a theme and
there is no toggle: neither stylesheet contains a `prefers-color-scheme` query. The band
re-tones five values and inherits everything else.

| Role | Light | Dark band |
|---|---|---|
| Page fill | `{colors.canvas}` `#ffffff` | `{colors-dark.canvas}` `#0b0b0b` |
| Card fill | `{colors.canvas-paper}` `#ededed` | `{colors-dark.canvas-soft}` `#212121` |
| Rules and card borders | `{colors.hairline}` `#ededed` | `{colors-dark.hairline}` `#353535` |
| Headings | `{colors.ink}` `#0b0b0b` | `{colors-dark.ink}` `#ffffff` |
| Body | `{colors.ink-soft}` `#212121` | `{colors-dark.body}` `#b9b9b9` |
| Accent | `{colors.brand}` `#f36458` | `{colors.brand}` `#f36458` unchanged |

The accent does not change value across the flip. Coral holds against both `#ffffff` and
`#0b0b0b`, which is most of the reason it was picked.

### Contrast, measured

These are computed against `{colors.canvas}` white, not estimated.

| Pair | Ratio | Verdict |
|---|---|---|
| `{colors.ink}` on canvas | 19.7:1 | passes everywhere |
| `{colors.ink-soft}` on canvas | 16.1:1 | passes everywhere |
| `{colors.slate-soft}` on canvas | 6.88:1 | passes everywhere |
| `{colors.ink}` on `{colors.brand}` | 6.35:1 | passes everywhere |
| `{colors.mute}` on canvas | 4.35:1 | short of 4.5:1 for small text |
| `{colors.success-text}` on canvas | 3.46:1 | short of 4.5:1 at the 10.5px it is used at |
| `{colors.brand}` on canvas | 3.10:1 | surfaces and large text only, never body |
| `{colors.ash}` on canvas | 1.96:1 | fine as a placeholder, too low for timestamps |

Two of these are open defects, not decisions. `{colors.mute}` carries most of the small mono
labels and lands just under the threshold; darkening it to roughly `#6e6e6e` would clear
4.5:1 without changing the feel. Transcript timestamps in `{colors.ash}` should move to
`{colors.mute}`. Both are cheap fixes that have not been made yet.

## Typography

### Font families

**Archivo**, licensed under the SIL Open Font Licence 1.1, used at weights 400, 500 and 600.
It carries every reading role in the system: display, titles, body, buttons, and the uppercase
micro-labels. It is a grotesque with tall x-height and open apertures, which is what makes a
15px application UI legible at a glance while a 112px hero still reads as one shape.

**IBM Plex Mono**, also SIL Open Font Licence 1.1. Both surfaces ship weights 400 and 500, and
every rule that sets it sets 400: the 500 file is downloaded and never used. The site likewise
requests Archivo 600 and never sets it. Both are cheap to trim and neither has been. It is used
as a labelling system, never for prose and never for code blocks in the marketing copy. Its roles
are timestamps, level-meter labels, section eyebrows, table headers, the status strip, and the
site's footer. In an app whose entire pitch is "the recording is exact", mono on anything
measured is a signal that the number came from the machine rather than from a writer.

The two surfaces load them differently, for a reason worth keeping.

The app self-hosts. `app/fonts/` holds `archivo-latin-wght.woff2`, a variable file declared at
`font-weight: 100 900` that covers 400, 500 and 600 from one download, plus
`ibm-plex-mono-400-latin.woff2` and `ibm-plex-mono-500-latin.woff2`. The app's Content Security
Policy sets `font-src 'self'`, so a remote stylesheet would simply be blocked. That is the
correct outcome: an app whose whole claim is that nothing leaves the machine should not fetch a
typeface from a third party every launch. The OFL text ships beside the files in
`app/fonts/OFL.txt`, which is what the licence requires.

The site loads the same two families from Google Fonts, since it is a public web page and the
offline argument does not apply to it:

```
https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap
```

Both stacks fall back to system faces, `system-ui, -apple-system, 'Segoe UI', sans-serif` and
`ui-monospace, Consolas, monospace`, and every face is declared `font-display: swap`, so text
is readable before the webfont resolves.

### Hierarchy

| Token | Size | Weight | Line height | Tracking | Use |
|---|---|---|---|---|---|
| `{typography.display-hero}` | clamp(46px, 8.4vw, 112px) | 400 | 1.0 | -0.04em | Site hero, one per page |
| `{typography.display-section}` | clamp(32px, 4.4vw, 48px) | 400 | 1.08 | -0.035em | Site section headlines |
| `{typography.title-detail}` | 26px | 500 | 1.1 | -0.026em | Meeting title in the detail pane |
| `{typography.title-meeting}` | 24px | 500 | 1.1 | -0.024em | The live meeting-title input |
| `{typography.doc-h2}` | 21px | 500 | 1.13 | -0.02em | Top-level heading in a rendered write-up |
| `{typography.lede}` | clamp(17px, 2vw, 20px) | 400 | 1.5 | -0.01em | Site hero sub-copy |
| `{typography.heading-card}` | 20px | 500 | 1.2 | -0.02em | Site card and step headings |
| `{typography.wordmark}` | 19px | 500 | 1.0 | -0.019em | App wordmark. 20px at -0.02em on the site |
| `{typography.doc-h3}` | 17px | 500 | 1.13 | -0.02em | Second-level heading in a write-up |
| `{typography.body}` | 16px | 400 | 1.5 | 0 | Site running copy |
| `{typography.body-app}` | 15px | 400 | 1.5 | 0 | App chrome, card copy, table cells |
| `{typography.prose}` | 15px | 400 | 1.62 | 0 | Rendered markdown in the detail pane |
| `{typography.notes}` | 15px | 400 | 1.68 | 0 | The notes textarea |
| `{typography.row-title}` | 14px | 500 | 1.3 | -0.014em | Meeting-list row titles |
| `{typography.snippet}` | 11.5px | 400 | 1.5 | 0 | Search-result snippets |
| `{typography.button}` | 16px | 500 | 1.0 | 0 | Site buttons |
| `{typography.button-app}` | 13px | 500 | 1.0 | -0.01em | App buttons |
| `{typography.caps-tab}` | 11px | 600 | 1.0 | 0.06em | App tabs. Detail tabs use 0.07em |
| `{typography.mono-eyebrow}` | 13px | 400 | 1.5 | 0.02em | Site eyebrows, the recording clock |
| `{typography.mono-caps}` | 11px | 400 | 1.5 | 0.1em | Uppercase eyebrows, table headers. Step numerals use 0.12em |
| `{typography.mono-foot}` | 13px | 400 | 1.6 | 0 | Site footer copy and links |
| `{typography.mono-note}` | 12px | 400 | 1.5 | 0 | The install note under the hero CTA |
| `{typography.mono-status}` | 10.5px | 400 | 1.5 | 0.03em | App status strip. Detail sub-line uses 0.05em |
| `{typography.mono-timestamp}` | 10.5px | 400 | 2.0 | 0 | Transcript timestamps, tabular figures |
| `{typography.mono-micro}` | 10px | 400 | 1.0 | 0.1em | Meter labels. Speaker tags use 0.08em, the on-top toggle 0.06em |

### Principles

- **One sans across every level.** Hierarchy is size and tracking. There is no second display
  family and no serif anywhere in the system.
- **Tracking tightens as size grows.** 0 at 15px and 16px, -0.02em in the low twenties,
  -0.035em at section size, -0.04em at the hero. Large Archivo set at default tracking reads
  as a row of separate letters rather than a phrase.
- **Display stays at weight 400.** The hero and every site headline are regular. At 112px
  the size is the emphasis, and a bold weight at that scale reads as shouting.
- **Weight 600 only for uppercase micro-labels.** Uppercase at 11px loses too much shape
  information at 500, so the tab labels take 600 and letter-spacing of 0.06em to 0.07em to
  reopen the counters.
- **Three body line heights, on purpose.** 1.5 for chrome, 1.62 for rendered prose you read,
  1.68 for the notes textarea you type into for an hour. Looser leading in a text area makes
  a cursor easier to find while your eyes are on a video call rather than on the app.
- **Mono never sets prose.** If a run of IBM Plex Mono is longer than about six words, it is
  in the wrong role.
- **Tabular figures wherever a number changes.** The recording clock, the second counters on
  the level meters, and transcript timestamps all set `font-variant-numeric: tabular-nums`.

### Substitutes

If Archivo is unavailable, the closest open substitutes are **Inter** and **Public Sans**, both
SIL OFL. Inter runs slightly wider, so pull display tracking about 0.005em tighter to hold the
hero on the same number of lines. IBM Plex Mono has no substitute worth making: it is open,
it is on Google Fonts, and its figures are already tabular. Keep it.

The system uses no OpenType feature settings. Every glyph is the default form. If a future
change wants alternates, they belong on display sizes only.

## Layout

### Spacing

Base unit is 4px. The steps actually in use are `{spacing.xxs}` 4px, `{spacing.xs}` 8px,
`{spacing.sm}` 12px, `{spacing.md}` 16px, `{spacing.lg}` 20px, `{spacing.xl}` 32px,
`{spacing.xxl}` 44px, `{spacing.section}` 64px, and `{spacing.section-lg}` 88px.

- The app gutters at `{spacing.md}` 16px throughout the notes view, and the header, transport,
  meters, sheet and action rows all align to that single left edge.
- The meetings detail pane gutters at 22px rather than `{spacing.lg}` 20px. That is drift, not
  a decision, and should fold into 20px the next time that pane is touched.
- Site sections are `{spacing.section-lg}` 88px of vertical padding with a
  `{colors.hairline}` rule between them. The hero is 96px top and 88px bottom, the one
  deliberate exception, so the first headline clears the sticky nav.
- Site cards pad at `{spacing.xl}` 32px and grid at `{spacing.lg}` 20px. The gap is smaller
  than the padding so a row of cards reads as one band rather than as separate objects.
- The site footer is 56px top and `{spacing.section}` 64px bottom.

### Grid and container

- The site content column is `max-width: 1120px` with `{spacing.xl}` 32px side padding,
  dropping to 20px below 640px. 1120px keeps `{typography.body}` at roughly 70 characters,
  and every prose block additionally caps itself: `max-width: 64ch` on body paragraphs,
  `58ch` on the lede, `20ch` on section headlines, `15ch` on the hero.
- Feature cards run a 2-column grid, step cards a 3-column grid, both collapsing to one column
  at 820px.
- The install section is an asymmetric `1.1fr .9fr` split so the numbered steps get more room
  than the sidebar callout beside them.
- The app is a flex column: a fixed 56px header, a growing view, a fixed 40px status strip.
  Nothing in the app scrolls the window itself; `body` sets `overflow: hidden` and only the
  inner panes scroll, so the header and status strip never leave.
- The meetings view is a two-pane split with a fixed 208px list column and a fluid detail
  pane. 208px fits a readable `{typography.row-title}` truncation without the list starting to
  compete with the document.
- The rendered write-up caps at `68ch` and a transcript at `76ch`, because a transcript's
  three-column layout spends 110px on the timestamp and speaker before the text starts.

### Whitespace

The app is dense on purpose. It sits on top of a video call in a window a person keeps small,
so padding is 12px to 22px and section gaps are 12px to 16px. The site is the opposite: 88px
between sections, 32px inside cards, and a hero that gives a single sentence most of a
viewport. They are the same system at two scales, and the scale is set by whether the reader
is working or deciding.

## Elevation and depth

There are no shadows. `box-shadow` appears zero times in `app/index.html` and zero times in
`docs/index.html`. Depth is four tones and a rule.

| Level | Treatment | Use |
|---|---|---|
| Sunk | `{colors.canvas-sunk}` `#f7f7f7` fill | The meetings list column |
| Flat | `{colors.canvas}` `#ffffff`, no border | The reading and writing surface |
| Bordered | `{colors.canvas}` with a 1px `{colors.hairline-strong}` border | Anything you can type into or click |
| Raised | `{colors.canvas-paper}` `#ededed` fill, a small radius, 1px `{colors.hairline}` border | Site cards at 12px, the callout at 6px, inactive tabs at 4px, code spans at 3px |
| Inverted | `{colors.ink}` fill, `{colors.canvas}` text | The active app tab and the primary button |
| Accent | `{colors.brand}` fill, `{colors.ink}` text | Record and Download only |

Two rules follow from this and are worth stating because they are easy to break:

- **A one-pixel border means interactive.** `{colors.hairline-strong}` `#dcdcdc` is the border
  of buttons, selects, text fields and the notes sheet. `{colors.hairline}` `#ededed` is the
  border of things that are only structure. Giving a static panel the stronger border makes
  people click it.
- **Inversion is the selected state.** The active tab is not a tinted tab, it is ink filled
  with white text. At 11px uppercase there is not enough surface for a subtle state, so the
  state is absolute.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Spec-table rows, level meters, full-width bands |
| `{rounded.xs}` | 3px | Text fields, the notes sheet, the write-up textarea, inline code |
| `{rounded.sm}` | 4px | App tab buttons |
| `{rounded.md}` | 5px | App secondary buttons and the provider select |
| `{rounded.lg}` | 6px | The unsigned-installer callout on the site |
| `{rounded.card}` | 12px | Site feature cards and step cards |
| `{rounded.full}` | 9999px | Pills, the brand dot, status pips, the recording indicator |

The app never rounds past 6px except for pills. A 12px corner on a 36px control eats a third
of its height and starts to read as a card rather than a button, and the app is full of small
controls sitting close together. The site can afford 12px because its cards are 32px-padded
and several hundred pixels wide.

Pills are reserved for the two commit actions: Record and Write up in the app, Download and
its neighbours on the site. Everything else is a rectangle with a small radius. The shape
itself is a hierarchy signal, so it only works while it stays scarce.

The brand dot is 8px in the app and 9px on the site, sized to the wordmark beside it, and sits
8px to 9px from it. It is a CSS `::after` on the wordmark rather than an image, so it inherits
the wordmark's colour context and never falls out of sync with it.

## Components

### Buttons

**`button`**, the app default
Background `{colors.canvas}`, text `{colors.ink-soft}`, 1px `{colors.hairline-strong}` border,
`{typography.button-app}`, `{rounded.md}`, height 36px, 14px horizontal padding. Hover fills
`{colors.canvas-paper}`, darkens text to `{colors.ink}` and moves the border to
`{colors.mute}`. Disabled drops to 36% opacity and cancels the hover.

**`button-primary`**, the ink pill
Background `{colors.ink}`, text `{colors.canvas}`, `{rounded.full}`, height 38px, 18px padding.
Hover goes to `#000`. This is the "Write up with" action: the one thing you do at the end of a
meeting.

**`button-record`**, the coral pill
Background `{colors.brand}`, text `{colors.ink}` at weight 600, `{rounded.full}`, height 38px.
It carries an 8px `currentColor` dot that pulses on a 1.3s ease-in-out loop while recording,
and the animation is cancelled under `prefers-reduced-motion: reduce`. This is the only
animated element in the app.

**`button-sm`**
The default button at height 30px, 11px padding, 12px type. Used for Clear, Folder, and the
per-meeting actions in the detail pane.

**`site-button-brand` / `site-button-ink` / `site-button-ghost`**
All 44px tall, `{rounded.full}`, `{typography.button}`, 22px padding. Brand is coral with ink
text, ink is the black fill with white text, ghost is transparent with a
`{colors.hairline-strong}` border. Focus-visible paints a 2px `{colors.link-on-dark}` outline
at 3px offset so it survives both the white page and the dark band.

### Navigation and chrome

**`app-header`**
56px tall, `{colors.canvas}`, 1px `{colors.hairline}` bottom border, 16px gutters. Left to
right: wordmark with brand dot, the two view tabs, a spacer, the always-on-top toggle.

**`tab-button` / `tab-button-active`**
Inactive is `{colors.canvas-paper}` with `{colors.mute}` text; active inverts to
`{colors.ink}` with `{colors.canvas}` text. Both are `{typography.caps-tab}`, `{rounded.sm}`,
32px tall. Focus-visible is a 2px `{colors.link}` outline at 1px offset.

**`site-nav`**
64px, sticky, `rgba(255,255,255,.92)` with an 8px backdrop blur and a `{colors.hairline}`
bottom border. Text links hide below 640px, leaving only the wordmark and the Download button.

**`app-footer`**
A 40px status strip in `{typography.mono-status}`, `{colors.mute}` by default,
`{colors.error}` on failure, `{colors.success-text}` on success. It is the app's only place
for transient messages: there are no toasts and no modals.

### Recording surface

**`transport`**
The title input, the clock, Record, Stop. The title is a borderless input at
`{typography.title-meeting}` that looks like a heading until you click it, because naming a
meeting should not feel like filling in a form.

**`meter`**
Two 2px `{colors.hairline}` tracks with a `{typography.mono-micro}` label and a
`tabular-nums` seconds count. The "you" bar fills `{colors.ink}`, the "them" bar fills
`{colors.slate-soft}`. That pairing is the same one used for transcript speaker labels, so
the colour that means "the other side" is consistent from the meter to the transcript. The
bars transition width over 0.09s linear, fast enough to read as a live level rather than an
animation.

**`notes-sheet`**
A full-height textarea, `{colors.canvas}`, 1px `{colors.hairline-strong}`, `{rounded.xs}`,
16px padding, `{typography.notes}`. The focus state moves the border to `{colors.mute}` and
nothing else. No ring, no glow: this element is focused nearly all the time the app is open,
so a persistent focus treatment would become the loudest thing on screen.

### Meetings library

**`meeting-list` / `meeting-row`**
A 208px `{colors.canvas-sunk}` column. Each row is 12px by 14px with a
`{colors.hairline}` bottom border and a 2px transparent left border. Hover fills
`{colors.canvas-paper}`. The selected row fills `{colors.canvas}`, lifting it to the same tone
as the detail pane beside it, and paints its left border `{colors.brand}`. Selection is
therefore two signals at once, tone and accent, which is what keeps it readable in peripheral
vision while you are reading the document.

**`status-pip`**
A 6px circle. `{colors.success}` filled means written up, `{colors.slate-soft}` filled means
transcribed, and a `{colors.ash}` outline with no fill means neither. An empty ring for the
empty state means the three states differ in shape as well as colour.

**`detail-tab` / `detail-tab-active`**
`{typography.caps-tab}` at 0.07em, no background, a 2px bottom border that goes from
transparent to `{colors.brand}`. This is the one place the accent marks something other than
a commit action, and it earns it: it is the only navigation inside the pane.

**`transcript-line`**
A three-column grid, `64px 46px 1fr` with a 12px gap: timestamp, speaker, text. The timestamp
is `{typography.mono-timestamp}`; the speaker is `{typography.mono-micro}` at 0.08em,
`{colors.ink}` for you and `{colors.slate-soft}` for them. Fixed columns rather than inline
labels mean the text edge is straight down the page, which is what makes a long transcript
skimmable.

### Cards and panels

**`card`**
`{colors.canvas-paper}`, 1px `{colors.hairline}`, `{rounded.card}` 12px, 32px padding. On the
dark band it becomes `card-on-dark`: `{colors-dark.canvas-soft}` `#212121` fill and
`{colors-dark.hairline}` `#353535` border. Nothing else about it changes.

**`step-card`**
A `card` with a `{typography.mono-caps}` numeral at 0.12em in `{colors.brand}` above a
`{typography.heading-card}` title. The numeral is one of the few coral text uses and it is
justified: the three steps are a sequence, and the accent is what makes the order visible
before you read a word.

**`callout`**
`{colors.canvas-paper}`, `{rounded.lg}` 6px, 20px padding, 14.5px text. Used once, for the
note explaining the unsigned installer. It has no icon and no coloured border. The point of
that box is to be read calmly, and a warning-styled panel would work against it.

**`spec-table-row`**
No fill, 16px by 12px cells, a `{colors.hairline}` bottom rule, `{typography.body-app}` at
-0.01em. Headers are `{typography.mono-caps}` in `{colors.mute}` over a `{colors.ink}` rule,
which is the only place a rule goes full black. The first column is `{colors.ink}` at weight
500 and 34% wide. The table sits inside an `overflow-x: auto` scroller so it never widens the
page on a phone.

### Inputs

**`text-field`**
`{colors.canvas}`, 1px `{colors.hairline-strong}`, `{rounded.xs}` 3px, 38px tall, 12px padding.
Focus moves the border to `{colors.mute}`. Placeholders are `{colors.ash}`.

**`select`**
The same treatment at `{rounded.md}` 5px and 36px, matching the buttons it sits beside in the
action row rather than the text fields elsewhere. Focus moves its border to `{colors.link}`.

**Focus rings**
Every focusable control that is not a text field paints `outline: 2px solid` in
`{colors.link}` in the app and `{colors.link-on-dark}` on the site, at 1px to 3px offset. Text
fields use a border change instead, because an outline outside a 3px-radius rectangle sits
awkwardly against the rounded corner.

### Section bands

**`site-section`**
`{colors.canvas}`, 88px vertical padding, 1px `{colors.hairline}` top rule.

**`band-dark`**
`{colors-dark.canvas}` `#0b0b0b`, headings `{colors-dark.ink}` white, body
`{colors-dark.body}` `#b9b9b9`, no top rule since the tone change is the divider. Used exactly
once, for the section that explains the engineering decisions. The flip is doing a specific
job there: it separates the argument for the product from the description of it.

**`site-footer`**
`{colors.canvas}`, 56px top and 64px bottom, a `{colors.hairline}` top rule, and everything in
`{typography.mono-foot}`, IBM Plex Mono at 13px with 1.6 leading. The footer is entirely
monospace, which closes the page on the same technical register the eyebrows opened it with.

## Do's and don'ts

### Do

- Keep the canvas white. If a new surface needs to recede, use `{colors.canvas-sunk}`; if it
  needs to rise, use `{colors.canvas-paper}`. Those are the only two moves.
- Reserve `{colors.brand}` as a fill for Record and Download. Everywhere else make it a mark:
  the brand dot, a 2px rule, a checkbox tick, a line of type that is counting. Use those only
  where the meaning is "this one is live or selected".
- Put `{colors.ink}` text on any coral surface, never white.
- Use `{colors.hairline-strong}` for the border of anything interactive and `{colors.hairline}`
  for anything structural.
- Set every changing number in IBM Plex Mono with `tabular-nums`.
- Keep display type at weight 400 and let size and negative tracking carry the hierarchy.
- Pair the brand dot with the wordmark every time the wordmark appears.
- Cap prose blocks in `ch` rather than pixels, so the measure holds when the type scale moves.
- Gate any animation behind `prefers-reduced-motion: reduce`, as the record pulse and the
  site's smooth scrolling already are.

### Don't

- Don't add a shadow. There are none in the system, and one would immediately look like it
  came from somewhere else.
- Don't introduce a second accent hue. The chromatic story is one coral against greyscale, and
  a second colour would break the "coral means live" rule by making colour ordinary.
- Don't use `{colors.brand}` for body text. It measures 3.10:1 on white.
- Don't set IBM Plex Mono for prose. Its roles are timestamps, eyebrows, labels, table headers
  and the status strip.
- Don't apply `{rounded.card}` 12px to app controls. The app tops out at 6px except for pills.
- Don't make pills ordinary. Two commit actions per surface, no more.
- Don't add a toast, a modal, or a notification. The 40px status strip is where the app speaks,
  and keeping it the only channel is what lets it be quiet.
- Don't put a focus ring on the notes textarea. It is focused almost the whole session.
- Don't add a dark-mode toggle without doing it properly. The dark band is one section of
  marketing copy, not half a theme, and shipping a toggle on top of it would leave most of the
  app's surfaces untested against `#0b0b0b`.

## Responsive behaviour

The site has two breakpoints. The app has none, and that is a decision rather than an
omission: it is an Electron window a user keeps deliberately small beside a call, so it is
built as a flex column that works at any window size instead of switching layouts at widths.

| Width | Change |
|---|---|
| 820px | Feature and step grids collapse from 2-up and 3-up to a single column. The install split collapses to one column and its gap tightens from 44px to 32px |
| 640px | Container padding drops from 32px to 20px. Nav text links hide, leaving the wordmark and the Download button |

Type scales continuously rather than in steps. `{typography.display-hero}` runs
`clamp(46px, 8.4vw, 112px)`, `{typography.display-section}` runs `clamp(32px, 4.4vw, 48px)`,
and the lede runs `clamp(17px, 2vw, 20px)`. Because tracking is set in `em`, it scales with the
size automatically and the hero never needs a per-breakpoint tracking correction.

The spec table does not reflow. It sits in an `overflow-x: auto` scroller and scrolls
sideways, because collapsing a two-column measured-values table into stacked pairs loses the
comparison that is the entire point of it.

Touch targets: site buttons are 44px, which clears the usual 44px guidance. App controls are
36px and 38px, below that guidance and acceptable because the app is a mouse-driven desktop
window with no touch build.

## Working on this system

1. Read the values out of `app/index.html` and `docs/index.html` before changing anything here.
   Both keep their tokens in a single `:root` block at the top of the file. This document is
   meant to describe what ships, so if the two disagree, the stylesheet wins and this file gets
   corrected.
2. Reference token names, not hex values, in prose and in comments. If a value has no token,
   that is a signal it should get one.
3. There is known drift worth folding in when those files are next touched: `#f5766b` (brand
   hover), `#000` (button hover), `#2a9d5c` (the status strip's success green), `#dcdcdc` on
   the site's ghost button, and `#0052ef` on the site's inline links are all inline literals
   rather than variables. `{colors.graphite}` and `{colors.slate}` are declared in the app
   stylesheet and referenced nowhere; the site declares neither. The app declares `--r-lg: 6px`
   and never uses it, and the site writes every radius as a literal rather than a variable. The
   app's `::selection` paints white on coral where every other coral surface takes ink.
4. The two stylesheets name a few tokens differently because one is written light-first and one
   carries a dark band: the app's `--canvas` is white, while the site's `--canvas` is the dark
   band and its white is `--canvas-light`. This document uses the app's naming, since the app is
   the product. Reconciling the two is a worthwhile small change.
5. Add new component variants as their own `components:` entry with a suffix, in the pattern of
   `-active`, `-on-dark`, `-sm`. Do not describe a variant only in prose.
6. Before adding a colour, check whether the thing you are marking is live, selected, or
   neither. If it is neither, it is grey.
