# MIN design system

The values here are read out of the `:root` block and rules in `app/index.html`. If this file
and that file disagree, the stylesheet wins and this file gets corrected.

Scope is the application: one shell, three views, and about forty components. The shell is a
CSS grid, `.shell { grid-template-columns: 200px minmax(0,1fr) }` at `index.html:143`, holding
a fixed 200px rail beside a main region. The main region carries a 48px `#topbar` and then
three sibling `section.view` elements, `#viewHome` (`:741`), `#viewNote` (`:761`) and
`#viewSettings` (`:859`), of which exactly one is visible at a time. `renderer.js` toggles the
global `.hide` class on them (`renderer.js:68`) from a three-entry `VIEWS` map
(`renderer.js:37-41`). There is no header inside a view and no status strip at the shell level:
the home and note views each dock their own `.bar` at the bottom, and the settings view has
none. A second, separate document, `app/indicator.html`, is the floating recording widget; it
has its own section at the end of this file.

The marketing page in `docs/index.html` is not documented here and, as of this rewrite, has not
been checked against these values.

## Principles

- **Off-white, not white.** The ground is `--surface` `#f7f7f2`, not `#ffffff`. White is
  reserved for things that sit on top of it: `--surface-raised` is exactly `#ffffff`, and it is
  the cards, the controls and the transcript card, never the page. Depth is two closely spaced
  off-whites, white above them, and one hairline. `box-shadow` appears zero times in `index.html` and zero times in `indicator.html`.
- **One chromatic accent, olive, in three steps.** `--accent` `#5b6f00` fills, `--accent-ink`
  `#788c15` writes, `--accent-soft` `#b2c248` tints and marks. Olive means captured or live:
  the Record fill, the "you" side of the transcript, today in the agenda, the mic pill while it
  runs, a good status line.
- **No second brand mark.** Coral survives on the installer and the app icon and nowhere in
  the interface. There was a `--brand` token feeding a 22px coral square with an "M" in it at
  the foot of the rail, beside the word MIN. Two marks for one product read as two products,
  so the square went and the token with it. The wordmark is the name, set bold.
- **Recording is a warning state, not a brand moment.** `#recBtn` is olive at rest and flips to
  `--danger-soft` with `--danger` text while running (`:626-628`). It is tinted, never filled,
  because a saturated red rectangle in the bar for an hour is a fire alarm.
- **Selection is a soft fill, not a stripe.** `.railItem.active` takes `--rail-active`, ink at
  9 percent alpha (`:177`). Ink at low alpha rather than a new grey means one hover value and
  one active value read correctly on all three grounds.
- **Six font sizes, nothing between them, nothing below 12px.** See the type scale below. This
  is the constraint the file was built around and the one most likely to be broken by accident.
- **Mono is for anything measured.** Clocks, timestamps, event times, the transcript count, the
  status line, the iCal field, the About values. Never prose. Everything that ticks also sets
  `font-variant-numeric: tabular-nums`.
- **Serif is the display face and nothing else.** Three rules use `--serif`: `h1.display`
  (`:239`), `.day-num` (`:294`) and `#noteTitle` (`:383`). It is what stops the window reading
  as a settings panel.
- **`--lh-ctl` is 1 and only ever on a single line centred in a box of known height.** The box
  does the centring. Putting it on wrapping text collapses the leading.
- **The transcript is docked, not floating.** `#transcriptPanel` is a sibling of the column and
  the bar, so it reflows with them rather than colliding with window chrome at the 900px
  minimum. The comment at `:456-466` records that an overlay was tried and rejected.

## Colours

Sixteen tokens carry colour or alpha. Every one of the 36 is referenced somewhere outside
`:root`; none is dead. Reference counts are deliberately not given. Three separate passes over
this file disagreed with each other on counting, and a count is the claim most certain to be
stale a week from now. What a token is for is stable; how many times it happens to be written
this morning is not.

| Token | Value | Used by |
|---|---|---|
| `--surface` | `#f7f7f2` | The canvas: `body` (`:131`), `#content` (`:196`), `.view > .bar` (`:231`), `.agenda-empty.link:hover` (`:330`) |
| `--surface-sunken` | `#f2f2ec` | `#rail` (`:146`), `.doc code` (`:451`), `#transcriptSearch` at rest (`:492`) |
| `--surface-raised` | `#ffffff` | Cards and controls: `#searchPill`, `.card`, `.btn`, `select`/`input`, `.askInner`, `.chip`, `#pasteNote`, `.panelInner`, `#transcriptSearch:focus`, `#micPill`. Also used as a text colour on `.btn.primary` (`:259`) |
| `--hairline` | `#e1e1db` | Nearly every 1px border and divider, plus the scrollbar thumb (`:220`, `:224`). The exceptions are deliberate: `.btn.primary` borders in `--ink`, `#recBtn` in `--accent`, and `.btn.ghost` starts transparent |
| `--ink` | `#1c1c1a` | Body text and every primary title |
| `--ink-2` | `#55554f` | Secondary text: rail items at rest, `.btn.ghost`, `.chip`, blockquote, `.kv .v` |
| `--ink-3` | `#8a8a82` | The most-used colour in the file. All tertiary text, every `::placeholder`, and the hover or focus border on `.btn`, `select`, `input`, `#pasteNote`, `#micPill` and the scrollbar thumb |
| `--accent` | `#5b6f00` | `.today-dot` (`:304`), `#recBtn` border and fill (`:617-618`), `.check input` `accent-color` (`:690`) |
| `--accent-ink` | `#788c15` | Olive as text or as a mark on a light ground: the focus ring (`:139`), today's numeral, `.now-label`, `.chip.accent` (`:394`), `.doc a`, `#micPill.live`, the "you" level bars, `#status.good`, `.fieldRow .result.good` (`:687`), `.kv .v a` |
| `--accent-soft` | `#b2c248` | `::selection` (`:136`), the tone fallbacks, `.chip.accent` border, `.bubble.copied` outline, `.bubble mark`, `#micPill.live` border, the "them" level bars |
| `--you-bubble` | `#e7ecd2` | 1 ref. `.bubble.you` (`:539`) |
| `--them-bubble` | `#ecece6` | 1 ref. `.bubble.them` (`:538`) |
| `--danger` | `#c2410c` | `.liveDot` (`:518`), `#recBtn.rec-on` text (`:627`), `#status.warn` (`:664`), `.fieldRow .result.warn` (`:688`) |
| `--danger-soft` | `#f6e2d8` | 1 ref. `#recBtn.rec-on` fill (`:627`) |
| `--rail-hover` | `rgba(28,28,26,.05)` | `.railItem:hover` (`:171`), `.btn.ghost:hover` (`:264`), `.note-row:hover` (`:345`) |
| `--rail-active` | `rgba(28,28,26,.09)` | `.railItem.on, .railItem.active` (`:177`) and `.btn.icon.on` (`:267`). The second selector matches nothing the app emits, so in practice this is the rail selection alone |

**No token in this file is dead.** That is the headline change from the previous version of
this document, which listed four declared-and-unused colours and one unused radius. All 36
custom properties on `index.html`'s `:root` are referenced by at least one rule outside it, and
all 9 on `indicator.html`'s `:root` are referenced there. The drift has moved in the other
direction: the tokens are clean and it is now the **rules** that have gone stale. See the
closing section.

### Custom properties that are consumed but never declared

Five properties are read with a fallback and never declared in `:root`. Three are written at
runtime by JavaScript; the other two, `--rest` and `--k`, are set by the stylesheet's own
`nth-child` rules (`:589-592`, `:646-648`) and only ever read with a fallback. A reader grepping `:root` will
not find them.

| Property | Fallback in CSS | Written by |
|---|---|---|
| `--tone-bg` | `var(--accent-soft)` on `.tile` (`:348`) | `home.js` `paintTone()`, inline per element (`home.js:128-133`) |
| `--tone-ink` | `var(--accent-soft)` on `.event-rule` (`:310`), `#fff` on `.tile` (`:348`) | same |
| `--lvl` | `0` on `#micPill .waveform i` (`:584`) and `#levelBars i` (`:641`) | `record.js`, per audio frame |
| `--rest` | `.4` on `#micPill .waveform i` (`:584`) | the four `nth-child` rules at `:589-592` |
| `--k` | `.6` on the mic pill, `1` on the level bars | `:589-592` and `:646-648` |

The eight tone pairs live in `home.js`, not in the stylesheet, hashed off the meeting title so a
meeting keeps its colour between sessions (`home.js:26-35`, `home.js:127-133`):

| Tone | Background | Ink |
|---|---|---|
| olive | `#e7ecd2` | `#5b6f00` |
| sand | `#f1e6d0` | `#8a6a1f` |
| clay | `#f3dfd4` | `#a3512e` |
| rose | `#f1dde3` | `#9a4560` |
| plum | `#e7dfee` | `#6b4c8c` |
| slate | `#dde5ee` | `#3f5f80` |
| teal | `#d9ebe6` | `#2f6f62` |
| stone | `#e6e6df` | `#55554f` |

Three of those sixteen values exist as tokens: olive's fill is `--you-bubble`, its ink is
`--accent`, and stone's ink is `--ink-2`. The other thirteen appear nowhere in either
stylesheet.

### Contrast

Every ratio below was computed from the two hex values using the WCAG relative luminance
formula and is stated to one decimal place. Ratios involving `rgba()` tokens are not stated,
because the composited result depends on which of the three grounds the element sits on.

Text on the three grounds. `--accent` is in the table for comparison only: it is a fill and a
border, never a text colour, which is the whole point of the defect noted below.

| Ink | on `--surface` | on `--surface-raised` | on `--surface-sunken` |
|---|---|---|---|
| `--ink` `#1c1c1a` | 15.9:1 | 17.1:1 | 15.2:1 |
| `--ink-2` `#55554f` | 7.0:1 | 7.5:1 | 6.7:1 |
| `--ink-3` `#8a8a82` | 3.2:1 | 3.5:1 | 3.1:1 |
| `--accent-ink` `#788c15` | 3.5:1 | 3.8:1 | 3.4:1 |
| `--accent` `#5b6f00` | 5.3:1 | 5.6:1 | 5.0:1 |
| `--danger` `#c2410c` | 4.8:1 | 5.2:1 | 4.6:1 |

Filled and tinted surfaces:

| Pair | Ratio |
|---|---|
| `#fff` on `--accent` `#5b6f00`, the Record button | 5.6:1 |
| `#fff` on `#4f6100`, Record hover | 6.9:1 |
| `--surface-raised` on `--ink`, `.btn.primary` | 17.1:1 |
| `--surface-raised` on `#000`, primary hover | 21.0:1 |
| `--danger` on `--danger-soft`, `#recBtn.rec-on` | 4.1:1 |
| `--danger` on `#f2d6c8`, that button's hover | 3.8:1 |
| `--ink` on `--you-bubble` `#e7ecd2` | 14.1:1 |
| `--ink` on `--them-bubble` `#ecece6` | 14.4:1 |
| `--ink` on `--accent-soft`, `::selection` and `.bubble mark` | 8.7:1 |

Non-text, for reference: `--hairline` on `--surface` is 1.2:1, on `--surface-raised` 1.3:1, on
`--surface-sunken` 1.2:1. `--accent-soft` on `--surface-raised` is 2.0:1. Those are borders and
2px to 3px bars, so 3:1 for non-text UI is the relevant bar and the hairline does not clear it
by design: it is meant to be felt, not read.

Tone ink on its own tone background, which is what a `.tile` initial renders as at 14px 600:

| Tone | Ratio | Tone | Ratio |
|---|---|---|---|
| olive | 4.7:1 | plum | 5.3:1 |
| sand | 4.1:1 | slate | 5.2:1 |
| clay | 4.3:1 | teal | 4.8:1 |
| rose | 4.8:1 | stone | 6.0:1 |

**What passes and what does not.** `--ink` and `--ink-2` clear 4.5:1 everywhere they appear.
`--ink-3` does not, at 3.1:1 to 3.5:1, and it is the file's most-used colour: 35 references
covering every placeholder, every timestamp, `.note-sub`, `.event-time`, `#status`, `.field
.help` and `.railLabel`, almost all of it at `--fs-xs` 12px. It clears the 3:1 bar for
non-text and for `:disabled`, and nothing else. `--accent-ink` at 3.4:1 to 3.8:1 is likewise
below 4.5:1, and it is used as text on `.now-label`, `.doc a`, `#status.good` and
`.fieldRow .result.good`. `--danger` on `--danger-soft` at 4.1:1 is the Record button's own
label while a meeting is being recorded, and its hover state drops that to 3.8:1. Two tone
tiles, sand at 4.1:1 and clay at 4.3:1, fall short at the 14px semibold the initial is set in.

None of those are decisions this document is defending. They are listed in the closing section.

## Typography

Three typefaces, all under the SIL Open Font License 1.1, all self-hosted in `app/fonts/` so a
launch makes no network request. The Content Security Policy pins `font-src 'self'`
(`index.html:26`, `indicator.html:19`), so a remote stylesheet would be blocked anyway. That is
the correct outcome for an app whose claim is that nothing leaves the machine. `fonts/OFL.txt`
carries the full licence text, and `fonts/README.md` gives the source of the Archivo and IBM
Plex Mono files but not of `instrument-serif-400-latin.woff2`, which ships and is used by three
rules with no provenance line of its own. Latin subset only,
with fallback stacks in `--sans`, `--mono` and `--serif`.

| Face | Token | Files | Role |
|---|---|---|---|
| Archivo | `--sans` | one variable file, `archivo-latin-wght.woff2`, 34,928 bytes, `font-weight:100 900`, `font-stretch:100%` | The interface default, set on `body` (`:132`) and restated in every `font` shorthand that is not mono or serif |
| IBM Plex Mono | `--mono` | two static files, `ibm-plex-mono-400-latin.woff2` 14,708 bytes and `ibm-plex-mono-500-latin.woff2` 14,888 bytes | Anything measured. Weight 500 is used in exactly one rule, `#clock` (`:623`); every other mono rule is 400 |
| Instrument Serif | `--serif` | one file, `instrument-serif-400-latin.woff2`, 21,032 bytes, weight 400 | `h1.display` and `#noteTitle`. Not the agenda numeral: that has to read as bold and this face ships at 400 only |

All three are `font-style:normal` and `font-display:swap`. Weights actually called on Archivo
are 400, 500, 600 and 700.

### The type scale, and the problem it solved

The comment at `:101-106` records what this replaced. The window had drifted to ten different
font sizes, 10px, 10.5px, 11.5px, 12.5px, 13.5px, 15px, 21px, 26px, 27px and 30px, arrived at
one rule at a time. The visible symptom was not that any single number was wrong: it was that
adjacent rows disagreed by half a pixel, so one row read as squished beside another that read
as oversized, and no amount of adjusting a single value fixed it because the next value along
was also improvised. Six sizes, with nothing between them and nothing below 12px, made those
comparisons impossible to get wrong. Every `font-size` in the file is now one of the six.

| Token | Value | Uses | Where |
|---|---|---|---|
| `--fs-display` | 24px | 2 | `h1.display` (`:239`), `#noteTitle` (`:383`). Both serif, both on `--lh-display` |
| `--fs-xl` | 20px | 2 | `.day-num` (`:294`), `.doc h2` (`:441`), which is the top level a write-up can produce since `md.js` maps `#` to `h2` |
| `--fs-lg` | 16px | 3 | `#notes` (`:400`), `.doc` (`:435`), `.doc h3` (`:441`). One step above interface text, so reading a write-up matches typing the notes |
| `--fs-md` | 14px | 10 | `body` (`:132`), `.empty`, `.event-title`, `.agenda-empty.link`, `.tile`, `.note-title`, `#ask`, `#pasteNote`, `.doc h4`, `.bubble` |
| `--fs-sm` | 13px | 18 | Controls and labels: `#searchPill`, `.railItem`, `#workspace .wm`, `.btn`, `select`/`input`, `.pasteHead`, `.doc code`, `.panelTitle`, `#transcriptSearch`, `#bubbles .empty`, `#recBtn`, `#clock`, `.group h2`, `.group .lede`, `.field label`, `.fieldRow input`, `.kv .k`, `.kv .v` |
| `--fs-xs` | 12px | 19 | The floor: `#searchPill kbd`, `.railLabel`, `#appVersion`, `.btn.sm`, `.day-stack`, `.now-label`, `.event-time`, `.note-day-label`, `.note-sub`, `.note-snip`, `.chip`, `#transcriptCount`, `.consent`, `.bubble .who`, `.bubble .ts`, `#status`, `.field .help`, `.fieldRow .result` |

`.doc h3` sharing `--fs-lg` with body text is deliberate: weight 600 and the 24px space above
it carry the level, not size. That is what keeps a three-level write-up from stepping down to
nothing by `h4`.

Four line-heights, three by role plus one flat:

| Token | Value | Uses | Role |
|---|---|---|---|
| `--lh-display` | 1.2 | 5 | Display type and the `.doc` heading block (`:437`). The fifth is `.day-stack` (`:298`), a 12px meta stack, which is the odd one out |
| `--lh-title` | 1.35 | 8 | Titles and meta lines that may wrap once |
| `--lh-body` | 1.5 | 10 | Anything you read a paragraph of |
| `--lh-ctl` | 1 | 22 | A single line centred in a box of known height. Never on wrapping text |

One hard-coded line-height survives on purpose, equal to its own box height so a single glyph
centres without a flexbox: `font:600 var(--fs-md)/32px var(--sans)` on `.tile`, the initial
beside a note in the list. It is commented.

Letter-spacing is set in eleven places and never tokenised: `-0.01em` on `h1.display`,
`-0.005em` on `#noteTitle`, `-0.02em` on `.doc` headings, `.08em` on `.now-label`, `.04em` on
`#workspace .wm` and `.event-time`, `.02em` on `#searchPill kbd`, `.railLabel`, `.bubble .who`
and `#status`, and `.01em` on `.day-stack`.

## Spacing and shape

There is no spacing token. Only three dimension tokens exist:

| Token | Value | Uses | Meaning |
|---|---|---|---|
| `--row` | 34px | 4 | One row height for every scannable list: `#searchPill` (`:151`), `.railItem` (`:166`), `.event` min-height (`:307`), `.note-row` min-height (`:343`) |
| `--col` | 640px | 3 | The reading measure. `.col` and `.barInner` cap at `calc(var(--col) + 2 * var(--gutter))` (`:208`, `:234`); `.panelInner` caps at the bare `var(--col)` (`:476`), which is why the transcript card is exactly as wide as the text you type and not as wide as the bar |
| `--gutter` | 32px | 6 | `.col` and `.barInner` padding and their max-width calc, `#askBar .barInner` (`:365`), `#transcriptPanel` (`:470`) |

Everything else is a literal. Card interiors pad at 16px (`.empty`, `.agenda-day`,
`.agenda-empty`, `.group`), list rows at 10px horizontally (`.note-row`, `.note-day-label`), the
rail at `12px 10px 10px`, and `#topbar` at `0 20px`. Gaps run 1px, 2px, 3px, 5px, 6px, 7px,
8px, 9px, 10px, 12px and 14px. A 4px base step is roughly observed and nowhere enforced.

| Radius | Value | Uses | Where |
|---|---|---|---|
| `--r-ctl` | 6px | `.btn`, `select`/`input` |
| `--r-card` | 12px | 5 | `.card` (`:244`), `.agenda-empty.link` (`:328`), `.askInner` (`:368`), `#pasteNote` (`:423`), `.panelInner` (`:478`) |
| `--r-pill` | 999px | 10 | `#searchPill`, `.btn.primary`, `.today-dot`, `.event-rule`, `.chip`, `#transcriptSearch`, `.liveDot`, `#micPill`, `#recBtn`, `#recBtn .dot` |

Eleven radii bypass those three: 8px on `.railItem` (`:167`), `.note-row` (`:343`) and `.tile`
(`:347`), 999px on the scrollbar thumb (`:224`), 12px on `.bubble` (`:535`), 4px on the two
bubble tails (`:538`, `:539`) and `.doc code` (`:451`), 3px on `.bubble mark` (`:505`), 1px on
the mic pill's waveform bars (`:582`) and 2px on the level bars (`:640`). 8px, used three times
on the three things you click in a list, and 4px, used on the two bubble tails and `.doc code`,
are each written three times.

### Motion

Two keyframes in `index.html`: `pulse` (`:667`), a 1.3s opacity loop on the record dot and the
live dot, and `pillHum` (`:613`), a 1.1s scale loop that only runs as a fallback when no audio
level has arrived for 500ms. There are exactly two durations: `.12s`, mostly for colour and
border but also for `.bubble .ts` opacity (`:549`) and the `#micPill .chev` rotate (`:598`),
and `90ms linear` for the audio bars. `@media (prefers-reduced-motion: reduce)` (`:668-673`)
kills both animations and both bar transitions; the colour change alone still says "recording".

There is exactly one width breakpoint in the whole system, `@media (max-width: 980px)` at
`:657`, which drops `#levelBars`. The window minimum is 900 by 620 (`main.js:135-136`), so at
the smallest window the bar has the mic pill, the Record button and a readable `#status`, and
loses the wide meter rather than truncating the status line. There is no
`prefers-color-scheme` query in either file.

## Components

| Component | Fill | Text | Radius | Size | Border |
|---|---|---|---|---|---|
| `#rail` | `--surface-sunken` | inherit | 0 | 200px wide, `12px 10px 10px` | 1px `--hairline` right |
| `#searchPill` | `--surface-raised` | `--ink-2`, `--ink` on hover | `--r-pill` | `--row`, `0 10px` | 1px `--hairline` |
| `.railLabel` | none | `--ink-3` | none | `--fs-xs` 500, `14px 10px 6px` | none |
| `.railItem` | none | `--ink-2` | 8px | `--row`, `0 10px`, 9px gap | none |
| `.railItem.active` | `--rail-active` | `--ink` | 8px | same | none |
| `#topbar` | inherit | inherit | 0 | 48px tall, `0 20px`, right-aligned | none |
| `.col` | none | inherit | 0 | `calc(--col + 2 * --gutter)`, `0 --gutter 24px` | none |
| `.view > .bar` | `--surface` | inherit | 0 | `.barInner` pads `10px --gutter` | 1px `--hairline` top |
| `h1.display` | none | `--ink` | none | `--fs-display`/`--lh-display` serif 400 | none |
| `.card` | `--surface-raised` | inherit | `--r-card` | content | 1px `--hairline` |
| `.btn` | `--surface-raised` | `--ink` | `--r-ctl` | 32px tall, `0 12px` | 1px `--hairline`, `--ink-3` on hover |
| `.btn.primary` | `--ink` | `--surface-raised` | `--r-pill` | 32px tall, `0 16px` | 1px `--ink` |
| `.btn.ghost` | none | `--ink-2` | `--r-ctl` | 32px tall | 1px transparent |
| `.btn.sm` | `--surface-raised` | `--ink` | `--r-ctl` | 28px tall, `0 10px`, `--fs-xs` | 1px `--hairline` |
| `select`, text inputs | `--surface-raised` | `--ink` | `--r-ctl` | 34px tall, `0 10px` | 1px `--hairline`, `--ink-3` on focus |
| `.agenda-day` | inherit | inherit | 0 | grid `64px minmax(0,1fr)`, 14px gap, `12px 16px` | 1px `--hairline` top between days |
| `.day-num` | none | `--ink`, `--accent-ink` today | none | `--fs-xl` serif, tabular | none |
| `.today-dot` | `--accent` | none | `--r-pill` | 5px, absolute at `left:-10px` | none |
| `.event` | none | inherit | 0 | grid `2px minmax(0,1fr)`, min-height `--row` | none |
| `.event-rule` | `--tone-ink` | none | `--r-pill` | 2px wide, full height | none |
| `.note-row` | none, `--rail-hover` on hover | `--ink` | 8px | grid `32px minmax(0,1fr) auto`, `5px 10px` | none |
| `.tile` | `--tone-bg` | `--tone-ink` | 8px | 32px square, `--fs-md` 600 | none |
| `.askInner` | `--surface-raised` | inherit | `--r-card` | 44px tall, `0 6px 0 14px` | 1px `--hairline` |
| `#noteTitle` | transparent | `--ink` | 0 | `--fs-display` serif | none |
| `.chip` | `--surface-raised` | `--ink-2` | `--r-pill` | 22px tall, `0 9px` | 1px `--hairline` |
| `#notes` | transparent | `--ink` | 0 | min-height 220px, `--fs-lg`/`--lh-body` | none |
| `#pasteNote` | `--surface-raised` | `--ink` | `--r-card` | min-height 96px, `10px 12px` | 1px `--hairline`, `--ink-3` on focus |
| `.doc code` | `--surface-sunken` | inherit | 4px | `--fs-sm` mono, `.12em .38em` | none |
| `#transcriptPanel` | none | inherit | 0 | `max-height:min(46vh,420px)`, min 160px, `0 --gutter 12px` | none |
| `.panelInner` | `--surface-raised` | inherit | `--r-card` | capped at `--col` | 1px `--hairline` |
| `.panelHead` | inherit | inherit | 0 | 40px tall, `0 8px 0 12px` | 1px `--hairline` bottom |
| `#transcriptSearch` | `--surface-sunken`, `--surface-raised` on focus | `--ink` | `--r-pill` | 26px tall, max 260px | 1px transparent, `--hairline` on focus |
| `.liveDot` | `--danger` | none | `--r-pill` | 7px, `pulse` 1.3s | none |
| `.bubble.them` | `--them-bubble` | `--ink` | 12px, 4px bottom-left | max-width 78%, `8px 12px` | none |
| `.bubble.you` | `--you-bubble` | `--ink` | 12px, 4px bottom-right | same | none |
| `.bubble .ts` | none | `--ink-3` | none | `--fs-xs` mono, absolute, opacity 0 until hover | none |
| `#micPill` | `--surface-raised` | `--ink-3`, `--accent-ink` when `.live` | `--r-pill` | 44px square | 1px `--hairline`, `--accent-soft` when `.live` |
| `#recBtn` | `--accent` | `#fff` 600 | `--r-pill` | 36px tall, `0 16px` | 1px `--accent` |
| `#recBtn.rec-on` | `--danger-soft` | `--danger` | `--r-pill` | same | 1px `rgba(194,65,12,.35)` |
| `#levelBars` | `--accent-soft` them, `--accent-ink` you | none | 2px | 3px by 22px bars, two clusters | none |
| `#status` | none | `--ink-3`, `--danger` warn, `--accent-ink` good | none | `--fs-xs` mono, right-aligned, ellipsis | none |
| `.group` | `--surface-raised` via `.card` | inherit | `--r-card` | `4px 16px 14px` | 1px `--hairline` |
| `.kv` | none | `--ink-3` key, `--ink-2` value | 0 | grid `96px minmax(0,1fr)`, `8px 0` | 1px `--hairline` top between rows |

Behaviour the table does not carry:

- **The mic pill is one control with two jobs.** It is the recording tell and the transcript
  toggle, and it is first in the bar so that "is this recording?" and "show me what it heard"
  are the same click. Its four waveform bars scale from a per-bar `--rest` floor, so a silent
  room still draws a waveform glyph rather than four invisible slivers.
- **The bars are olive, not red,** because they are the same green as the "you" side of the
  transcript they open. They read as capture, not as an alarm. The comment at `:557-566`
  records that.
- **`.hum` is a liveness fallback, not decoration.** `record.js` adds it when no audio level has
  arrived for 500ms, so a stalled worklet never leaves four frozen bars claiming to be a live
  recording. Real levels win: `.hum` comes off the moment one lands.
- **The level meter is keyed off the record button,** `#noteBar:not(:has(#recBtn.rec-on))
  #levelBars { opacity:.35 }` (`:651`), rather than a second class on the meter. One source of
  truth for "is this recording?".
- **`.view > .bar` is a direct-child selector on purpose.** `bar` is also the class on each
  `<i>` in `#levelBars` (`:850-851`), and unscoped this rule capped every level bar with a
  hairline.
- **A copied bubble flashes** with a `--accent-soft` outline (`:504`) rather than announcing
  itself in the status line, so the click and the feedback are in the same place.
- **`.bubble .who[hidden]` needs its own rule** (`:545`). The `.bubble .who` rule is more
  specific than the browser's `[hidden]`, so without it the speaker's name repeats on every
  bubble of a run.
- **Scrollbars are overridden** to a 10px overlay with a `--hairline` thumb and a 3px
  transparent inset (`:220-228`). The Windows default is a wide grey slab that reads as window
  chrome and fights the column.
- **The consent line lives in the transcript footer,** not in settings, because a tool that
  records other people should say so where the recording is visible.
- **Nothing in this file is a modal or a toast.** `#status` is the only channel for transient
  messages, and `renderer.js` refuses navigation away from a live recording rather than opening
  a dialog about it.

## The floating recording indicator

`app/indicator.html` is a separate always-on-top window, 132 by 44 (`main.js:613-614`), loaded
from `main.js:780`. The document is the widget: the body is transparent and `#pill` fills it
edge to edge. That rules out a drop shadow, which would be clipped at the window bounds, so the
pill earns its legibility on a wallpaper from a hairline border and a near-opaque white fill
instead, which is consistent with the rest of MIN having no shadows.

**It copies tokens rather than importing them, and it has to.** The widget is a second
top-level document in a separate BrowserWindow. It cannot reach the renderer's stylesheet, and
its own CSP pins `style-src` to `'self' 'unsafe-inline'` with no shared file to link. So its
`:root` (`indicator.html:40-51`) declares nine tokens, eight of them restated by hand from
`index.html` and one, `--bar-idle`, that exists only there. The comment at
`:38-39` states the contract: copied from `index.html`, not re-picked, and anything added later
should be copied across verbatim.

| Token | Value | Same as `index.html`? |
|---|---|---|
| `--hairline` | `#e1e1db` | yes |
| `--ink` | `#1c1c1a` | yes |
| `--ink-2` | `#55554f` | yes |
| `--accent-ink` | `#788c15` | yes |
| `--danger` | `#c2410c` | yes |
| `--danger-soft` | `#f6e2d8` | yes |
| `--mono` | `'IBM Plex Mono', ui-monospace, Consolas, monospace` | yes |
| `--r-pill` | `999px` | yes |
| `--bar-idle` | `rgba(28,28,26,.32)` | **no. This token exists only here** |

**What that obliges you to do.** Changing any of those eight values in `index.html` means
changing it in `indicator.html` in the same commit, by hand. Nothing enforces it: there is no
build step, no shared file, and no test that compares the two `:root` blocks. A drift will not
throw, it will simply put a slightly different grey on the desktop from the one in the window,
and the two are rarely on screen together, so nobody will notice for weeks.

The duplication is also incomplete, which is a second thing to watch. `indicator.html` carries
no `--sans`, no `--serif`, no `--fs-*` and no `--lh-*`, so its type is hard-coded: `font:400
14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif` on `body` (`:60`) and `font:400
12px/1 var(--mono)` on `#clock` (`:129`). Those two numbers happen to equal `--fs-md` and
`--fs-xs` at `--lh-body` and `--lh-ctl`, but they are written as literals and will not follow
the scale if it moves. It also has no `--surface` family, so the pill ground is the literal
`rgba(255,255,255,.9)` (`:81`), deliberately not opaque so a hint of wallpaper reads as
floating. And the widget uses the platform sans rather than Archivo, so the one label it could
show would not match the app; today it shows no sans text at all, only the mono clock, which is
what keeps that from being visible.

What is genuinely shared by duplication, and must stay in step: the four `--rest`/`--k` waveform
pairs (`index.html:589-592`, `indicator.html:108-111`), the `pillHum` keyframe and its three
animation delays, the `90ms linear` bar transition, and the `.hum` 500ms stall rule. A silent
room is supposed to draw the identical waveform glyph in the bar and on the desktop. `--bar-idle`
is the one value that went the other way, invented in the widget and never back-ported;
`#micPill` instead rests on `currentColor` inherited from `--ink-3`.

## Don't

- **Don't add a shadow.** There are none in either file, and one would look imported.
- **Don't introduce a second accent hue.** Olive means captured or live. A second colour makes
  colour ordinary.
- **Don't bring coral back into the interface.** It lives on the installer and the app icon.
  A second hue in the window makes olive ordinary, and a second mark makes the wordmark
  ordinary.
- **Don't use `--ink-3` for anything a user has to read carefully.** At 3.1:1 to 3.5:1 it is
  already carrying more than it should.
- **Don't add a font size.** Six is the whole point. If something needs to be between 13px and
  14px, the answer is weight, colour or space.
- **Don't put `--lh-ctl` on text that can wrap.**
- **Don't add a breakpoint without a reason as concrete as the one at 980px.** The window has a
  900px floor, not a phone.
- **Don't add a dark mode by adding a media query.** Neither file has ever been tested against a
  dark ground, and the three-off-white depth model does not invert: it would have to be
  redesigned, not recoloured.
- **Don't edit `indicator.html`'s tokens independently.** Copy from `index.html` or change both.

## Known inconsistencies

This is the section the file exists for. Everything below is a defect or a drift, read out of
the current source, not a decision being defended.

### Rules matched by nothing the app emits

The previous version of this document listed dead tokens. There are none left. The dead things
are now selectors.

1. `.railItem.on` and `.railItem.on svg` (`:177`, `:179`). `renderer.js` toggles only `.active`
   (`renderer.js:72`) and the markup ships `.active` on `#navHome` (`:710`). The comment at
   `:172-176` defends keeping `.on` on the grounds that "the markup shipped with it". It did
   not, and does not: `on` appears in no element in `index.html` and is set by no module. The
   rule is harmless, but the comment justifying it is false and should be corrected or the
   selector dropped.
2. `.btn.icon` (`:266`) and `.btn.icon.on` (`:267`). No markup and no module assigns `icon`.
   `#closeTranscript`, the one button shaped like an icon button, is `class="btn ghost sm"`
   (`:814`) and gets its 26px width from its own id rule at `:501`. Its height is the 28px of
   `.btn.sm` (`:265`), so it is 26 by 28 rather than square.
3. `.note-snip` and `.note-snip b` (`:362-363`). Nothing emits `note-snip`. `home.js` renders
   `.note-row` with no snippet, so the search-result excerpt these style is not built. This is
   the only rule that would make a search hit look different from a normal row.
4. `.chip.accent` (`:394`). `record.js` `renderMeta` emits the variants `time`, `duration`,
   `segments`, `attendees`, `recurring` and `auto` (`record.js:845-868`), never `accent`. It is
   the only rule that would tint a chip, so in practice every chip is neutral and the six
   variant classes it does emit style nothing.
5. `#bubbles .empty` (`:554`). No module places an `.empty` node inside `#bubbles`;
   `conversation.js` only ever appends `.bubble` elements.

### Classes the app emits with no rule

6. `muted`, on every agenda and list empty paragraph (`home.js:262`, `:267`, `:286`, `:351`,
   `:353`, `:354`). There is no `.muted` rule. Those paragraphs get their grey from
   `.agenda-empty` or from `.list-empty`. Three of the six are built inside `.list-empty` and inherit
   `--ink-3` from it, so the class is doing nothing anywhere.
7. `mono`, on `.event-time` (`home.js:238`) and `.note-time` (`home.js:310`). There is no
   `.mono` rule. The mono look comes from `.event-time, .note-time` at `:321`.
8. `tone-0` through `tone-7`, added by `paintTone` (`home.js:130`) with the comment that they
   are "for the stylesheet to refine". The stylesheet has no `tone-N` rule.
9. Also unstyled: `.text` inside a bubble (`conversation.js:71`), `.day-month` and
   `.day-weekday` (`home.js:213-214`, named only in the contract comment at `:281-282` and
   inheriting from `.day-stack`), `.note-day` (`home.js:372`), `.event.now` (`home.js:228`;
   only `.now-label` is styled), `today` added to `.day-head` as well as to `.agenda-day`
   (`home.js:218` against the `.agenda-day.today` selector at `:301`), `live` added to `#clock`
   (`record.js:542`), and the `.label` span inside `#recBtn` (`record.js` markup at
   `index.html:841`, which `.field .label` at `:681` does not reach).

10. `live`, toggled on the bubble container by `renderBubbles` (`conversation.js:138`) on
    every call from `record.js`. No rule reaches `#bubbles.live` or `.live` in that position.
    The recording tell that does work is `.recording` on `#transcriptPanel`, set by
    `record.js`; this second one has never done anything.

### Gaps in the rendered-markdown styles

10. `md.js` can emit `<h5>`. Its heading rule is
    `Math.min(heading[1].length + 1, 5)` (`md.js:59`), so `####` renders as `h5`, and `.doc`
    styles `h2`, `h3` and `h4` only (`:436`, `:441`). A four-hash heading in a pasted write-up
    falls to the browser default: bold, roughly 13px, wrong margins, no letter-spacing, and
    smaller than the body text around it.
11. `md.js` also emits `<em>` (`md.js:21-22`), which `.doc` does not mention. Browser italic is
    probably right, but it is unstated where `strong` is stated at `:446`.
12. `md.js` exports `renderTranscript` (`md.js:113`), which emits `p.line`, `span.ts` and
    `span.who.you|.them`. Nothing imports it, and `.doc` has no rule for any of those three
    classes. Either the export is dead or the styles are missing; today it is the export.
13. The comment at `:433` says `.doc` is "for write-ups and read-mode notes". The `doc` class
    appears on exactly one element, `#writeUp` (`:796`), and `record.js:910` is the only caller.
    Read-mode notes do not exist yet.

### Colour and contrast defects

14. `--ink-3` `#8a8a82` carries 35 references at 3.2:1 on the canvas, 3.5:1 on cards and 3.1:1
    on the rail, nearly all of it at 12px. It fails 4.5:1 everywhere it is used as text.
    `#6e6e68` would clear 4.5:1 on all three grounds (4.8:1, 5.1:1, 4.6:1) without changing the
    feel; that is a one-line change with a wide blast radius, so it wants a deliberate pass
    rather than a drive-by.
15. `--accent-ink` `#788c15` is below 4.5:1 on all three grounds (3.5:1, 3.8:1, 3.4:1) and is
    used as text on `.now-label`, `.doc a`, `#status.good`, `.fieldRow .result.good`,
    `.chip.accent` and `.kv .v a`. `--accent` `#5b6f00` clears it at 5.3:1 and 5.7:1, which
    suggests the two roles are the wrong way round for text on light: the fill colour is the
    readable one.
16. `#recBtn.rec-on` puts `--danger` on `--danger-soft` at 4.1:1, and its hover drops that to
    3.8:1. A hover state that is less legible than its rest state is backwards.
17. The `.tile` initial is 14px at weight 600 on tone backgrounds ranging from 4.1:1 (sand) to
    6.0:1 (stone). Sand and clay fall short of 4.5:1.
18. `--hairline` on `--surface` is 1.2:1. That is a decision for a rule you feel rather than
    read, but it means the border on `.btn` is nearly invisible until hover moves it to
    `--ink-3`, and a resting button on the canvas is close to a floating label.

### Untokenised literals

19. `#fff` twice: the `.tile` `--tone-ink` fallback and `#recBtn` colour. There is no white text token, even though
    `--surface-raised` is `#ffffff` and is already used as a text colour on `.btn.primary`
    (`:259`). Two names for the same white, one of them a fill token doing a text job.
20. `#000` twice on `.btn.primary:hover` (`:262`), a darker step past `--ink` with no token.
21. `#4f6100` twice on `#recBtn:hover` (`:621`), a darker olive than `--accent` with no token.
22. `#f2d6c8` on `#recBtn.rec-on:hover` (`:629`), a darker step past `--danger-soft` with no
    token.
23. `rgba(194,65,12,.35)` on `#recBtn.rec-on` (`:627`). That is `--danger` at 35 percent alpha
    written out longhand, because there is no alpha-danger token and `color-mix` is not used
    anywhere in the file.
24. Thirteen of the sixteen tone palette values (`home.js:26-35`) exist nowhere in the
    stylesheet. A designer reading `index.html` alone will not know they are in the product.

### Structural drift

25. `#topbar` pads at `0 20px` (`:200`) while every column and bar pads at `var(--gutter)`
    32px. The "+ New note" button therefore does not line up with the text column beneath it.
26. The comment block at `:211-214` explaining why `.view > .bar` is a direct-child selector
    sits above the scrollbar comment and the six scrollbar rules, not above `.view > .bar`
    itself at `:230`. It reads as an explanation of the scrollbars.
27. The `<kbd>` inside the empty note list (`home.js:356`) has no rule reaching it. The only
    `kbd` rule is scoped `#searchPill kbd` (`:157`), so that one renders in the browser's
    default monospace at the browser's default size, outside the type scale.
28. The Archivo `@font-face` comment says "One variable file carries 400, 500 and 600" (`:60`),
    but the rail wordmark and the agenda numeral both ask for 600 or 700. The comment is one
    weight behind the stylesheet.
29. Eleven letter-spacing values are set inline with no token, and no rule about when tracking
    tightens. `-0.02em` on `.doc` headings and `-0.01em` on `h1.display` are the same idea at
    two values.
30. The IBM Plex Mono 500 file (14,888 bytes) is downloaded for one rule, `#clock` (`:623`).
    That is a real cost for one element; either more mono should be 500 or that one should be
    400.

## Working on this system

1. Read the values out of `app/index.html` before changing anything here. Its tokens are in one
   `:root` block at `:80-126` and there is no external stylesheet: the whole design system is
   the single inline `<style>` at `:28-697`.
2. Reference token names, not hex values. If a value has no token, that is a signal it should
   get one, and item 19 to 23 above is the current backlog.
3. If you change a colour, a radius or `--mono`, check whether `indicator.html:40-51` copies it.
   Eight values are duplicated there by hand and nothing will tell you if they drift.
4. If you add a class in `home.js`, `record.js` or `conversation.js`, add its rule in the same
   commit or do not add the class. The list at items 6 to 9 is what happens otherwise.
5. Before adding a colour, ask whether the thing you are marking is captured or live. If it is
   neither, it is grey.
