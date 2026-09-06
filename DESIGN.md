# MIN design system

The values here are read out of the `:root` block and rules in `app/index.html`. If this file
and that file disagree, the stylesheet wins and this file gets corrected.

Scope is the application: one shell, three views, and about fifty components. The shell is a
CSS grid, `.shell { grid-template-columns: 200px minmax(0,1fr) }` at `index.html:140`, holding
a fixed 200px rail beside a main region. The main region carries a 48px `#topbar` and then
three sibling `section.view` elements, `#viewHome` (`:843`), `#viewNote` (`:867`) and
`#viewSettings` (`:963`), of which exactly one is visible at a time. `renderer.js` toggles the
global `.hide` class on them (`renderer.js:68`) from a three-entry `VIEWS` map
(`renderer.js:37-41`). There is no header inside a view and no status strip at the shell level:
the home and note views each dock their own `.bar` at the bottom, and the settings view has
none.

Two further top-level documents ship beside it, each its own always-on-top window and each with
its own hand-copied tokens: `app/indicator.html`, the floating recording widget, and
`app/notify.html`, the prompt that appears before a calendar meeting. They have their own
sections at the end of this file.

The marketing page in `docs/index.html` is not documented here and, as of this rewrite, has not
been checked against these values.

## Principles

- **Off-white, not white.** The ground is `--surface` `#f7f7f2`, not `#ffffff`. White is
  reserved for things that sit on top of it: `--surface-raised` is exactly `#ffffff`, and it is
  the cards, the controls, the transcript card and the row menu, never the page. Depth is two
  closely spaced off-whites, white above them, and one hairline. There is exactly one
  `box-shadow` in the whole system, on `.row-menu` (`:474`), and it is a lapse rather than a
  layer: see the closing section. `indicator.html` and `notify.html` have none.
- **One chromatic accent, olive, in three steps.** `--accent` `#5b6f00` fills, `--accent-ink`
  `#788c15` writes, `--accent-soft` `#b2c248` tints and marks. Olive means captured or live:
  the Record fill, the "you" side of the transcript, the mic pill while it runs, a good status
  line, and the focus ring on everything. Today in the agenda used to be olive too and is not
  any more; that is listed below rather than defended here.
- **No second brand mark.** Coral survives on the installer and the app icon and nowhere in
  the interface. There was a `--brand` token feeding a 22px coral square with an "M" in it at
  the foot of the rail, beside the word MIN. Two marks for one product read as two products,
  so the square went and the token with it. The wordmark is the name, set bold.
- **Recording is a warning state, not a brand moment.** `#recBtn` is olive at rest and flips to
  `--danger-soft` with `--danger` text while running (`:756-758`). It is tinted, never filled,
  because a saturated red rectangle in the bar for an hour is a fire alarm.
- **Selection is a soft fill, not a stripe.** `.railItem.active` takes `--rail-active`, ink at
  9 percent alpha (`:177`). Ink at low alpha rather than a new grey means one hover value and
  one active value read correctly on all three grounds.
- **A row that opens something behaves like a button.** Both list rows in the app, `.event`
  (`:370-375`) and `.note-row` (`:424-429`), carry `cursor:pointer` and a `--rail-hover` fill,
  and `home.js` gives each one `tabIndex` and `role="button"` (`home.js:315-316`,
  `home.js:402-404`). They are divs, so the treatment is the only thing telling a user they are
  targets. Focus is where the two part company, and not by design: `.event` keeps the global
  ring, `.note-row` cancels it with `outline:none` and reuses the hover fill. Item 40 below.
- **Six font sizes, nothing between them, nothing below 12px.** See the type scale below. This
  is the constraint the file was built around and the one most likely to be broken by accident.
  Two rules currently break it, both added with the agenda pager and the row menu.
- **Mono is for anything measured.** Clocks, timestamps, event times, the transcript count, the
  note bar's status line, the iCal field, the About values. Never prose. Everything that ticks
  also sets `font-variant-numeric: tabular-nums`. Home's status line is the exception and is
  listed below.
- **Serif is the display face and nothing else.** Two rules use `--serif`: `h1.display`
  (`:262`) and `#noteTitle` (`:513`). It is what stops the window reading as a settings panel.
  The agenda numeral is deliberately not one of them: it has to read as bold and the face ships
  at 400 only, so `.day-num` is sans 600 at the same 24px (`:347`).
- **`--lh-ctl` is 1 and only ever on a single line centred in a box of known height.** The box
  does the centring. Putting it on wrapping text collapses the leading.
- **The transcript is docked, not floating.** `#transcriptPanel` is a sibling of the column and
  the bar, so it reflows with them rather than colliding with window chrome at the 900px
  minimum. The comment at `:587-596` records that an overlay was tried and rejected.

## Colours

Sixteen tokens carry colour or alpha. Every one of the 35 is referenced somewhere outside
`:root`; none is dead. Reference counts appear below only where the count is the point, as it is
for a token that survives on a single rule. Otherwise they are left out: three separate passes
over this file disagreed with each other on counting, and a count is the claim most certain to
be stale a week from now. What a token is for is stable; how many times it happens to be written
this morning is not.

| Token | Value | Used by |
|---|---|---|
| `--surface` | `#f7f7f2` | The canvas: `body` (`:127`), `#content` (`:194`), `.view > .bar` (`:253`), `.agenda-empty.link:hover` (`:413`) |
| `--surface-sunken` | `#f2f2ec` | `#rail` (`:142`), `.doc code` (`:579`), `#transcriptSearch` at rest (`:619`) |
| `--surface-raised` | `#ffffff` | Cards and controls: `#searchPill`, `.card`, `.btn`, `select`/`input`, `.askInner`, `.chip`, `#pasteNote`, `.row-menu`, `.panelInner`, `#transcriptSearch:focus`, `#micPill`. Also used as a text colour on `.btn.primary` (`:282`) |
| `--hairline` | `#e1e1db` | Nearly every 1px border and divider, the scrollbar thumb (`:246`), and the agenda's `.agenda-rule` (`:341`), which is a filled 1px grid track rather than a border. The exceptions are deliberate: `.btn.primary` borders in `--ink`, `#recBtn` in `--accent`, and `.btn.ghost` starts transparent |
| `--ink` | `#1c1c1a` | Body text and every primary title, including `.day-month` (`:357`) |
| `--ink-2` | `#55554f` | Secondary text: rail items at rest, `.btn.ghost`, the three agenda pager buttons at rest, `.chip`, blockquote, `.kv .v` |
| `--ink-3` | `#8a8a82` | The most-used colour in the file. All tertiary text, every `::placeholder`, `.day-weekday`, `.row-more` at rest, and the hover or focus border on `.btn`, `select`, `input`, `#pasteNote`, `#micPill` and the scrollbar thumb |
| `--accent` | `#5b6f00` | Two rules only: `#recBtn` border and fill (`:747-748`), `.check input` `accent-color` (`:793`) |
| `--accent-ink` | `#788c15` | Olive as text or as a mark on a light ground: the focus ring (`:136`, restated on `.event` at `:375`), `.now-label` (`:395`), `.chip.accent` (`:524`), `.doc a` (`:577`), `#micPill.live` (`:733`), `#status.good` (`:768`), `#homeStatus.good` (`:449`), `.fieldRow .result.good` (`:790`), `.kv .v a` (`:798`) |
| `--accent-soft` | `#b2c248` | `::selection` (`:133`), the tone fallbacks (`:386`, `:432`), `.chip.accent` border, `.bubble.copied` outline, `.bubble mark`, `#micPill.live` border |
| `--you-bubble` | `#e7ecd2` | 1 ref. `.bubble.you` (`:669`) |
| `--them-bubble` | `#ecece6` | 1 ref. `.bubble.them` (`:668`) |
| `--danger` | `#c2410c` | `.today-dot` (`:366`), `#homeStatus.warn` (`:450`), `.row-menu-item.danger` (`:482`), `.liveDot` (`:648`), `#recBtn.rec-on` text (`:757`), `#status.warn` (`:767`), `.fieldRow .result.warn` (`:791`) |
| `--danger-soft` | `#f6e2d8` | `#recBtn.rec-on` fill (`:757`) and `.row-menu-item.danger:hover` (`:483`) |
| `--rail-hover` | `rgba(28,28,26,.05)` | The one hover fill in the app: `.railItem` (`:171`), `.btn.ghost` (`:287`), `.agenda-nav-btn` (`:323`), `.agenda-nav-today` (`:331`), `.event` (`:374`), `.note-row` (`:429`), `.row-menu-item` (`:481`) |
| `--rail-active` | `rgba(28,28,26,.09)` | `.railItem.on, .railItem.active` (`:177`), `.btn.icon.on` (`:290`) and `.row-more:hover` (`:467`). The second selector matches nothing the app emits |

**No token in this file is dead.** All 35 custom properties on `index.html`'s `:root`
(`:80-124`) are referenced by at least one rule outside it, all 9 on `indicator.html`'s and all
16 on `notify.html`'s are referenced there. The drift has moved in the other direction: the
tokens are clean and it is the **rules** that go stale. See the closing section.

`--fs-xl` is the thinnest of them, down to a single reference now that the agenda numeral has
moved to `--fs-display`. One reference is not dead, but it is the token to watch.

### Custom properties that are consumed but never declared

Five properties are read with a fallback and never declared in `:root`. Three are written at
runtime by JavaScript; the other two, `--rest` and `--k`, are set by the stylesheet's own
`nth-child` rules (`:719-722`) and only ever read with a fallback. A reader grepping `:root`
will not find them. The three waveform properties are read in one place, the mic pill. The tone
pair is not: `--tone-bg` is read only on the tile (`:432`), `--tone-ink` on both the tile and the
event's coloured rule (`:386`).

| Property | Fallback in CSS | Written by |
|---|---|---|
| `--tone-bg` | `var(--accent-soft)` on `.tile` (`:432`) | `home.js` `paintTone()`, inline per element (`home.js:130-136`) |
| `--tone-ink` | `var(--accent-soft)` on `.event-rule` (`:386`), `#fff` on `.tile` (`:432`) | same |
| `--lvl` | `0` on `#micPill .waveform i` (`:714`) | `record.js:246`, per audio frame |
| `--rest` | `.4` on `#micPill .waveform i` (`:714`) | the four `nth-child` rules at `:719-722` |
| `--k` | `.6` on `#micPill .waveform i` (`:714`) | the same four rules |

The eight tone pairs live in `home.js`, not in the stylesheet, hashed off the meeting title so a
meeting keeps its colour between sessions (`home.js:26-35`, `home.js:130-136`):

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
1px to 3px bars, so 3:1 for non-text UI is the relevant bar and the hairline does not clear it
by design: it is meant to be felt, not read.

Tone ink on its own tone background, which is what a `.tile` initial renders as at 14px 600:

| Tone | Ratio | Tone | Ratio |
|---|---|---|---|
| olive | 4.7:1 | plum | 5.3:1 |
| sand | 4.1:1 | slate | 5.2:1 |
| clay | 4.3:1 | teal | 4.8:1 |
| rose | 4.8:1 | stone | 6.0:1 |

**What passes and what does not.** `--ink` and `--ink-2` clear 4.5:1 everywhere they appear.
`--ink-3` does not, at 3.1:1 to 3.5:1, and it is the file's most-used colour, covering every
placeholder, every timestamp, `.note-sub`, `.day-weekday`, `#homeStatus`, `#status`, `.field
.help` and `.railLabel`, almost all of it at `--fs-xs` 12px. It clears the 3:1 bar for
non-text and for `:disabled`, and nothing else. `--accent-ink` at 3.4:1 to 3.8:1 is likewise
below 4.5:1, and it is used as text on `.now-label`, `.doc a`, `#status.good`,
`#homeStatus.good` and `.fieldRow .result.good`. `--danger` on `--danger-soft` at 4.1:1 is the
Record button's own label while a meeting is being recorded, and its hover state drops that to
3.8:1. Two tone tiles, sand at 4.1:1 and clay at 4.3:1, fall short at the 14px semibold the
initial is set in.

None of those are decisions this document is defending. They are listed in the closing section.

## Typography

Three typefaces, all under the SIL Open Font License 1.1, all self-hosted in `app/fonts/` so a
launch makes no network request. The Content Security Policy pins `font-src 'self'` in all
three documents (`index.html:26`, `indicator.html:19`, `notify.html:23`), so a remote
stylesheet would be blocked anyway. That is the correct outcome for an app whose claim is that
nothing leaves the machine. `fonts/OFL.txt` carries the full licence text and a copyright line for each
of the three, and `fonts/README.md` gives the source URL of every file including
`instrument-serif-400-latin.woff2`. Latin subset only, with fallback stacks in `--sans`,
`--mono` and `--serif`.

| Face | Token | Files | Role |
|---|---|---|---|
| Archivo | `--sans` | one variable file, `archivo-latin-wght.woff2`, 34,928 bytes, `font-weight:100 900`, `font-stretch:100%` | The interface default, set on `body` (`:127`) and restated in every `font` shorthand that is not mono or serif |
| IBM Plex Mono | `--mono` | two static files, `ibm-plex-mono-400-latin.woff2` 14,708 bytes and `ibm-plex-mono-500-latin.woff2` 14,888 bytes | Anything measured. Weight 500 is used in exactly one rule, `#clock` (`:753`); every other mono rule in every window is 400 |
| Instrument Serif | `--serif` | one file, `instrument-serif-400-latin.woff2`, 21,032 bytes, weight 400 | `h1.display` and `#noteTitle`, nothing else |

All three are `font-style:normal` and `font-display:swap`. Weights actually called on Archivo
are 400, 500, 600 and 700. Neither of the other two windows loads Archivo: both name the
platform sans instead, and `notify.html` says why at `notify.html:69-74`.

### The type scale, and the problem it solved

The comment at `:98-103` records what this replaced. The window had drifted to ten different
font sizes, 10px, 10.5px, 11.5px, 12.5px, 13.5px, 15px, 21px, 26px, 27px and 30px, arrived at
one rule at a time. The visible symptom was not that any single number was wrong: it was that
adjacent rows disagreed by half a pixel, so one row read as squished beside another that read
as oversized, and no amount of adjusting a single value fixed it because the next value along
was also improvised. Six sizes, with nothing between them and nothing below 12px, made those
comparisons impossible to get wrong.

| Token | Value | Uses | Where |
|---|---|---|---|
| `--fs-display` | 24px | 3 | `h1.display` (`:262`), `.day-num` (`:347`), `#noteTitle` (`:513`). The two titles are serif on `--lh-display`; the agenda numeral is sans 600 on a flat 1 |
| `--fs-xl` | 20px | 1 | `.doc h2` (`:571`), which is the top level a write-up can produce since `md.js` maps `#` to `h2` |
| `--fs-lg` | 16px | 3 | `#notes` (`:526`), `.doc` (`:565`), `.doc h3` (`:571`). One step above interface text, so reading a write-up matches typing the notes |
| `--fs-md` | 14px | 11 | `body` (`:127`), `#workspace .wm`, `.empty`, `.event-title`, `.agenda-empty.link`, `.tile`, `.note-title`, `#ask`, `#pasteNote`, `.doc h4`, `.bubble` |
| `--fs-sm` | 13px | 19 | Controls, labels and every time stamp in a list: `#searchPill`, `.railItem`, `.btn`, `select`/`input`, `.event-time, .note-time`, `.row-menu-item`, `.pasteHead`, `.doc code`, `.panelTitle`, `#transcriptSearch`, `#bubbles .empty`, `#recBtn`, `#clock`, `.group h2`, `.group .lede`, `.field label`, `.fieldRow input`, `.kv .k`, `.kv .v` |
| `--fs-xs` | 12px | 19 | The floor: `#searchPill kbd`, `.railLabel`, `#appVersion`, `.btn.sm`, `.agenda-nav-today`, `.day-stack`, `.now-label`, `.note-day-label`, `.note-sub`, `#homeStatus`, `.note-snip`, `.chip`, `#transcriptCount`, `.consent`, `.bubble .who`, `.bubble .ts`, `#status`, `.field .help`, `.fieldRow .result` |

Two rules are outside the six and the comment at `:98-103` still claims none are: 17px on
`.agenda-nav-btn` (`:321`), where the glyph is a single guillemet and `--fs-sm` left it reading
as punctuation rather than an arrow, and 15px on `.row-more` (`:461`), where the glyph is a
midline ellipsis. Both are icon-sized text rather than reading text, which is the argument for
them, but neither is written down as a decision and neither has a token.

`.doc h3` sharing `--fs-lg` with body text is deliberate: weight 600 and the 24px space above
it carry the level, not size. That is what keeps a three-level write-up from stepping down to
nothing by `h4`.

Four line-heights, three by role plus one flat:

| Token | Value | Uses | Role |
|---|---|---|---|
| `--lh-display` | 1.2 | 3 | The two display titles and the `.doc` heading block (`:566`) |
| `--lh-title` | 1.35 | 8 | Titles and meta lines that may wrap once |
| `--lh-body` | 1.5 | 10 | Anything you read a paragraph of |
| `--lh-ctl` | 1 | 25 | A single line centred in a box of known height. Never on wrapping text |

Five line-heights are hard-coded rather than tokenised. One is on purpose and commented, equal
to its own box height so a single glyph centres without a flexbox: `font:600 var(--fs-md)/32px
var(--sans)` on `.tile` (`:434`), the initial beside a note in the list. `.day-stack` sets
`/1.25` (`:351`), a value that exists nowhere else. The remaining three, `.day-num` (`:347`),
`.agenda-nav-btn` (`:321`) and `.row-more` (`:461`), all write a flat `1` where `--lh-ctl` says
exactly that.

Letter-spacing is set in eleven rules and never tokenised: `.01em` on `h1.display`, `#noteTitle`
and `.day-stack`; `.02em` on `#searchPill kbd`, `.railLabel`, `.event-time, .note-time`,
`.bubble .who` and `#status`; `.06em` on `#workspace .wm`; `.08em` on `.now-label`; and
`-0.02em` on `.doc` headings, the only negative one left. The display serif carried negative
tracking until the note header was rewritten; the comment at `:505-510` records why it went.

## Spacing and shape

There is no spacing token. Only three dimension tokens exist:

| Token | Value | Uses | Meaning |
|---|---|---|---|
| `--row` | 34px | 4 | One row height for every scannable list: `#searchPill` (`:150`), `.railItem` (`:165`), `.event` min-height (`:370`), `.note-row` min-height (`:424`) |
| `--col` | 640px | 3 | The reading measure. `.col` and `.barInner` cap at `calc(var(--col) + 2 * var(--gutter))` (`:223`, `:256`); `.panelInner` caps at the bare `var(--col)` (`:606`), which is why the transcript card is exactly as wide as the text you type and not as wide as the bar. Home opts out: `#viewHome > .col` (`:233`) caps at 880px plus gutters, because a list of rows is not prose and a class title beside its time was wrapping inside a column sized for paragraphs |
| `--gutter` | 32px | 7 | `.col` (`:223`) and `.barInner` (`:256`) padding and their max-width calcs, `#viewHome > .col` (`:233`), `#askBar .barInner` (`:489`), `#transcriptPanel` (`:597`) |

Everything else is a literal. Card interiors pad at 16px (`.empty`, `.group` at `4px 16px 14px`,
`.agenda-empty` at `14px 16px`), the agenda day at `16px 22px`, list rows at 10px horizontally
(`.note-row`, `.note-day-label`), the rail at `14px 10px 10px`, and `#topbar` at `0 20px` with a
computed right pad. Gaps run 1px, 2px, 5px, 6px, 7px, 8px, 9px, 10px and 12px, plus the agenda
grid's single 18px column gap. A 4px base step is roughly observed and nowhere enforced.

| Radius | Value | Uses | Where |
|---|---|---|---|
| `--r-ctl` | 6px | 6 | `.btn` (`:274`), `select`/`input` (`:294`), `.agenda-nav-btn` (`:320`), `.event` (`:372`), `.row-more` (`:460`), `.row-menu-item` (`:478`) |
| `--r-card` | 12px | 6 | `.card` (`:267`), `.agenda-empty.link` (`:411`), `.row-menu` (`:474`), `.askInner` (`:492`), `#pasteNote` (`:553`), `.panelInner` (`:608`) |
| `--r-pill` | 999px | 11 | `#searchPill`, `.btn.primary`, `.agenda-nav-today`, `.today-dot`, `.event-rule`, `.chip`, `#transcriptSearch`, `.liveDot`, `#micPill`, `#recBtn`, `#recBtn .dot` |

Ten declarations bypass those three: 8px on `.railItem` (`:167`), `.note-row` (`:427`) and
`.tile` (`:431`), 999px on the scrollbar thumb (`:247`), 12px on `.bubble` (`:665`), 4px on the
two bubble tails (`:668`, `:669`) and `.doc code` (`:581`), 3px on `.bubble mark` (`:635`), and
1px on the mic pill's waveform bars (`:712`). 8px, used three times on the three things you
click in a list, and 4px, used on the two bubble tails and `.doc code`, are each written three
times.

### Motion

Two keyframes in `index.html`: `pulse` (`:770`), a 1.3s opacity loop on the record dot and the
live dot, and `pillHum` (`:743`), a 1.1s scale loop that only runs as a fallback when no audio
level has arrived for 500ms. There are exactly two durations: `.12s`, for colour, border, the
`.bubble .ts` opacity (`:679`), the `.row-more` reveal (`:462`) and the `#micPill .chev` rotate
(`:728`), and `90ms linear` for the waveform bars. `@media (prefers-reduced-motion: reduce)`
(`:771-776`) kills both animations and the bar transition; the colour change alone still says
"recording".

There is no width breakpoint left in the system. The only `@media` in `index.html` is the
reduced-motion one. The single 980px query the file used to carry existed to drop the wide
second meter from the note bar, and it went when that meter did: the bar now holds the mic pill,
the Record button and `#status`, and there is nothing left that needs to be shed at the 900 by
620 window minimum (`main.js:140-141`). There is no `prefers-color-scheme` query in any of the
three documents.

## Components

| Component | Fill | Text | Radius | Size | Border |
|---|---|---|---|---|---|
| `#rail` | `--surface-sunken` | inherit | 0 | 200px wide, `14px 10px 10px`; drag region, buttons and links excluded (`:147`, `:149`) | 1px `--hairline` right |
| `#searchPill` | `--surface-raised` | `--ink-2`, `--ink` on hover | `--r-pill` | `--row`, `0 10px` | 1px `--hairline` |
| `.railLabel` | none | `--ink-3` | none | `--fs-xs` 500, `14px 10px 6px` | none |
| `.railItem` | none | `--ink-2` | 8px | `--row`, `0 10px`, 9px gap | none |
| `.railItem.active` | `--rail-active` | `--ink` | 8px | same | none |
| `#topbar` | inherit | inherit | 0 | 48px tall, `0 20px` with a computed right pad, right-aligned; drag region, buttons excluded (`:215`, `:217`) | none |
| `.col` | none | inherit | 0 | `calc(--col + 2 * --gutter)`, 880px plus gutters on home, `0 --gutter 24px` | none |
| `.view > .bar` | `--surface` | inherit | 0 | `.barInner` pads `10px --gutter` | 1px `--hairline` top |
| `h1.display` | none | `--ink` | none | `--fs-display`/`--lh-display` serif 400 | none |
| `.section-head` | none | inherit | 0 | flex, baseline-aligned, 12px gap; `#agendaNav` pushed to the end with `margin-left:auto` | none |
| `.agenda-nav-btn` | transparent, `--rail-hover` on hover | `--ink-2`, `--ink-3` at 40 percent when disabled | `--r-ctl` | 26px square, 17px glyph | none |
| `.agenda-nav-today` | transparent, `--rail-hover` on hover | `--ink-2` | `--r-pill` | 26px tall, `0 9px`, `--fs-xs` 500 | none |
| `.card` | `--surface-raised` | inherit | `--r-card` | content | 1px `--hairline` |
| `.btn` | `--surface-raised` | `--ink` | `--r-ctl` | 32px tall, `0 12px` | 1px `--hairline`, `--ink-3` on hover |
| `.btn.primary` | `--ink` | `--surface-raised` | `--r-pill` | 32px tall, `0 16px` | 1px `--ink` |
| `.btn.ghost` | none | `--ink-2` | `--r-ctl` | 32px tall | 1px transparent |
| `.btn.sm` | `--surface-raised` | `--ink` | `--r-ctl` | 28px tall, `0 10px`, `--fs-xs` | 1px `--hairline` |
| `select`, text inputs | `--surface-raised` | `--ink` | `--r-ctl` | 34px tall, `0 10px` | 1px `--hairline`, `--ink-3` on focus |
| `.agenda-day` | inherit | inherit | 0 | grid `104px 1px minmax(0,1fr)`, `0 18px` gap, `16px 22px` | 1px `--hairline` top between days |
| `.agenda-rule` | `--hairline` | none | 0 | the middle grid track, 1px wide, `align-self:stretch` | none |
| `.day-num` | none | `--ink` | none | `--fs-display` sans 600 on a flat 1, tabular | none |
| `.day-month` / `.day-weekday` | none | `--ink` 500 / `--ink-3` | none | `--fs-xs` in `.day-stack`, month and dot on one line | none |
| `.today-dot` | `--danger` | none | `--r-pill` | 5px, inline in `.day-month-row` | none |
| `.event` | none, `--rail-hover` on hover | inherit | `--r-ctl` | grid `3px minmax(0,1fr)`, 12px gap, min-height `--row`, `cursor:pointer` | none; 2px `--accent-ink` focus ring |
| `.event-rule` | `--tone-ink` | none | `--r-pill` | 3px wide, stretched with a 2px vertical margin | none |
| `.note-row` | none, `--rail-hover` on hover and focus | `--ink` | 8px | grid `32px minmax(0,1fr) auto 26px`, 12px gap, `5px 10px`, `position:relative` | none |
| `.tile` | `--tone-bg` | `--tone-ink` | 8px | 32px square, `--fs-md` 600 | none |
| `.row-more` | transparent, `--rail-active` on hover | `--ink-3`, `--ink` on hover | `--r-ctl` | 26px square, 15px glyph, `opacity:0` until the row is hovered or focused | none |
| `.row-menu` | `--surface-raised` | inherit | `--r-card` | absolute under the row, min 160px, `padding:4px` | 1px `--hairline`, plus the file's one shadow |
| `.row-menu-item` | transparent, `--rail-hover` on hover | `--ink`, `--danger` when `.danger` | `--r-ctl` | full width, `7px 10px`, `--fs-sm` | none |
| `#homeStatus` | none | `--ink-3`, `--danger` warn, `--accent-ink` good | none | `--fs-xs` sans, right-aligned, ellipsis, inside `.askInner` | none |
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
| `#status` | none | `--ink-3`, `--danger` warn, `--accent-ink` good | none | `--fs-xs` mono, right-aligned, ellipsis | none |
| `.group` | `--surface-raised` via `.card` | inherit | `--r-card` | `4px 16px 14px` | 1px `--hairline` |
| `.kv` | none | `--ink-3` key, `--ink-2` value | 0 | grid `96px minmax(0,1fr)`, `8px 0` | 1px `--hairline` top between rows |

Behaviour the table does not carry:

- **The mic pill is one control with two jobs.** It is the recording tell and the transcript
  toggle, and it is first in the bar so that "is this recording?" and "show me what it heard"
  are the same click. Its four waveform bars scale from a per-bar `--rest` floor, so a silent
  room still draws a waveform glyph rather than four invisible slivers.
- **It is also the only meter left.** The note bar used to carry a second, wider one beside the
  Record button, and the markup comment where it stood (`:950-956`) records why it went: the
  pill already shows the level, it is the one that travels to the floating window, and the wide
  meter was the same information a second and third time. Its removal is also what gives
  `#status` room to be read.
- **The bars are olive, not red,** because they are the same green as the "you" side of the
  transcript they open. They read as capture, not as an alarm. The comment at `:687-696`
  records that.
- **`.hum` is a liveness fallback, not decoration.** `record.js` adds it when no audio level has
  arrived for 500ms, so a stalled worklet never leaves four frozen bars claiming to be a live
  recording. Real levels win: `.hum` comes off the moment one lands.
- **`.view > .bar` is a direct-child selector on purpose,** so it cannot reach a `bar` class
  used for something else inside a view. Nothing inside a view carries one today; the elements
  that did were the level-meter bars.
- **The agenda pager is by meeting, not by day.** `home.js` flattens the next 14 days and slices
  five events at a time (`home.js:170-171`, `home.js:360-362`), so the card is one height
  whether a day holds one meeting or nine. `.agenda-day` is a three-column grid rather than a
  bordered date column so the divider can stretch the height of a row without the date owning a
  border it would then have to suppress on the last day (`:334-339`).
- **The pager renders itself out of existence on one page.** `renderAgendaNav` returns early
  when the total fits a single page (`home.js:262`), and the Today button is only built once
  paged away (`home.js:266-272`). The two arrows stay in place and go `:disabled` at the ends rather
  than being hidden, so the pair does not jump.
- **The overflow button is revealed by CSS, not by script** (`:452-457`). It keeps its 26px grid
  column whether or not it is visible, so nothing shifts on hover, and it appears on
  `:focus-within` as well as `:hover` because it is the only route to deleting a meeting and
  that has to be reachable from the keyboard.
- **The row menu is anchored to the row,** `position:absolute` against `.note-row`'s
  `position:relative` (`:469-471`), so it travels with the row while the list scrolls rather
  than being left behind at a fixed point.
- **A copied bubble flashes** with a `--accent-soft` outline (`:634`) rather than announcing
  itself in the status line, so the click and the feedback are in the same place.
- **`.bubble .who[hidden]` needs its own rule** (`:675`). The `.bubble .who` rule is more
  specific than the browser's `[hidden]`, so without it the speaker's name repeats on every
  bubble of a run.
- **Scrollbars are overridden** to a 10px overlay with a `--hairline` thumb and a 3px
  transparent inset (`:243-251`). The Windows default is a wide grey slab that reads as window
  chrome and fights the column.
- **The consent line lives in the transcript footer,** not in settings, because a tool that
  records other people should say so where the recording is visible.
- **Nothing in this file is a modal or a toast.** `#status` and `#homeStatus` are the only
  channels for transient messages, and `renderer.js` refuses navigation away from a live
  recording rather than opening a dialog about it. The row menu is the closest thing to a
  popover and it is one item long.

## The floating recording indicator

`app/indicator.html` is a separate always-on-top window, 132 by 44 (`main.js:656-657`), loaded
from `main.js:823`. The document is the widget: the body is transparent and `#pill` fills it
edge to edge. That rules out a drop shadow, which would be clipped at the window bounds, so the
pill earns its legibility on a wallpaper from a hairline border and a near-opaque white fill
instead.

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
pairs (`index.html:719-722`, `indicator.html:108-111`), the `pillHum` keyframe and its three
animation delays, the `90ms linear` bar transition, and the `.hum` 500ms stall rule. A silent
room is supposed to draw the identical waveform glyph in the bar and on the desktop. `--bar-idle`
is the one value that went the other way, invented in the widget and never back-ported;
`#micPill` instead rests on `currentColor` inherited from `--ink-3`.

## The meeting prompt

`app/notify.html` is the third window: a card in the top right of the screen about a minute
before a calendar meeting, 320 by 137 (`main.js:968`, `main.js:973`), loaded from
`main.js:1032`. Like the indicator, the document is the window: the body is transparent and
`#card` fills it, which again rules out a shadow and leaves a hairline border to do the work.

The height is measured rather than chosen. At 118 the window cut 17px off the bottom of the
"Take notes" button, measured against the laid-out card; 137 is the card's own height, so it now
fits with two pixels to spare. The comment at `main.js:969-972` records both numbers. The window
has to fit the card, not the other way round, and squeezing the card to a round number is what
produced the clipped button in the first place.

Two decisions separate it from the indicator, both written down in the source. The card is
**fully opaque** where the recording nub is deliberately translucent (`notify.html:36-39` in the
header comment): the nub is a status light, but this one carries a meeting title that has to be
read in a glance, and wallpaper showing through the letters costs more than the floating look is
worth. And the window is **not focusable** (`main.js:1006-1014`): it appears while a meeting is
starting, which is the worst moment to pull focus off a call. A `focusable:false` window still
receives clicks, so the buttons work, but key events never reach it, which is why the dismiss X
in the corner is the way out and Escape is not.

**It copies tokens by hand, exactly as the indicator does, and for the same reason.** Its
`:root` (`notify.html:50-60`) declares sixteen, every one of them restated verbatim from
`index.html` and none invented here:

`--surface-raised`, `--hairline`, `--ink`, `--ink-2`, `--ink-3`, `--accent-ink`, `--rail-hover`,
`--mono`, `--fs-md`, `--fs-sm`, `--fs-xs`, `--lh-title`, `--lh-body`, `--lh-ctl`, `--r-card`,
`--r-pill`.

**What that obliges you to do.** The same as the indicator, with a wider surface area: sixteen
values instead of eight, and no build step, no shared file and no test comparing the blocks.
Change any of those sixteen in `index.html` and change them here in the same commit. Unlike the
indicator, this window is on screen for three minutes at a time and only just before a meeting,
so a drift here has even less chance of being caught by eye.

The copying is deliberate but not total, and the gaps are the same shape as the indicator's:

- No `--sans`. The comment at `notify.html:69-75` gives the reason: a separate BrowserWindow
  loads its own copy of any face it names, and a 35 KB Archivo download in front of a card that
  has to be legible the instant it appears is a bad trade for one weight of one font. The card
  is the platform sans; the app is Archivo; nobody sees them together.
- No `--accent` and no `--danger`, because the card has no accent-filled control and no warning
  state. It does take one of the `--surface` family: `--surface-raised` is both the card's ground
  (`:93`) and the "Take notes" label sitting on its dark fill (`:137`). That is the difference
  from the indicator, which copies none of that family and writes a literal ground instead.
- Two literals are copied rather than tokenised, both already untokenised in `index.html`:
  `#000` on `#notifyTake:hover` (`:143`), which is `.btn.primary:hover`, and the 320px card
  width, which matches `NOTIFY_WIDTH` in `main.js` and has to.

What is shared by intent rather than by accident, and should stay that way: `.eyebrow`
(`notify.html:101-105`) is `.now-label` from the agenda, the same `--accent-ink` uppercase at
`--fs-xs` with `.08em` tracking, because the two are saying the same thing about the same event.
`#notifyTake` (`:131-143`) is `.btn.primary`. `#notifyTime` (`:122-129`) is mono and tabular
like every other time in MIN. `#notifyDismiss` (`:147-154`) takes `--rail-hover`, the one hover
fill.

## Don't

- **Don't add a shadow.** There is exactly one in the whole system, on `.row-menu`, and both
  other windows cite the absence of shadows as the reason they earn their edges from a hairline
  instead. A second would turn a lapse into a style.
- **Don't introduce a second accent hue.** Olive means captured or live. A second colour makes
  colour ordinary.
- **Don't bring coral back into the interface.** It lives on the installer and the app icon.
  A second hue in the window makes olive ordinary, and a second mark makes the wordmark
  ordinary.
- **Don't use `--danger` for anything that is not a warning, a recording or a destructive
  action.** It is already carrying today's dot in the agenda, which is none of those.
- **Don't use `--ink-3` for anything a user has to read carefully.** At 3.1:1 to 3.5:1 it is
  already carrying more than it should.
- **Don't add a font size.** Six is the whole point, and there are already two rules outside
  them. If something needs to be between 13px and 14px, the answer is weight, colour or space.
- **Don't put `--lh-ctl` on text that can wrap.**
- **Don't add a width breakpoint without a concrete reason.** There are none left in the file;
  the one that existed went with the meter it was hiding. The window has a 900px floor, not a
  phone.
- **Don't add a dark mode by adding a media query.** None of the three documents has ever been
  tested against a dark ground, and the three-off-white depth model does not invert: it would
  have to be redesigned, not recoloured.
- **Don't edit `indicator.html`'s or `notify.html`'s tokens independently.** Copy from
  `index.html` or change all three.

## Known inconsistencies

This is the section the file exists for. Everything below is a defect or a drift, read out of
the current source, not a decision being defended.

### Rules matched by nothing the app emits

The tokens are clean. The dead things are selectors.

1. `.railItem.on` and `.railItem.on svg` (`:177`, `:179`). `renderer.js` toggles only `.active`
   (`renderer.js:72`) and the markup ships `.active` on `#navHome` (`:813`). The comment at
   `:172-176` defends keeping `.on` on the grounds that "the markup shipped with it". It did
   not, and does not: `on` appears in no element in `index.html` and is set by no module. The
   rule is harmless, but the comment justifying it is false and should be corrected or the
   selector dropped.
2. `.btn.icon` (`:289`) and `.btn.icon.on` (`:290`). No markup and no module assigns `icon`, and
   three more icon-shaped buttons have shipped since without using it: `#closeTranscript` is
   `class="btn ghost sm"` (`:920`) with a 26px width from its own id rule at `:631` and a 28px
   height from `.btn.sm`, so it is 26 by 28 rather than square, while `.agenda-nav-btn` and
   `.row-more` each got their own 26px square rule. Whatever `.btn.icon` was for, three
   opportunities to use it have now been declined.
3. `.note-snip` and `.note-snip b` (`:486-487`). Nothing emits `note-snip`. `home.js` renders
   `.note-row` with no snippet, so the search-result excerpt these style is not built. It now
   also declares `grid-column:2 / -1` against a grid that grew a fourth column, so if it were
   ever emitted it would span the overflow button as well.
4. `.chip.accent` (`:524`). `record.js` `renderMeta` emits the variants `time`, `duration`,
   `segments`, `attendees`, `recurring` and `auto` (`record.js:794-834`), never `accent`. It is
   the only rule that would tint a chip, so in practice every chip is neutral, including the
   "From calendar" chip (`record.js:834`) that marks the one thing about a note worth marking.
5. `#bubbles .empty` (`:684`). No module places an `.empty` node inside `#bubbles`;
   `conversation.js` only ever appends `.bubble` elements.

### Classes the app emits with no rule

6. `muted`, on every agenda and list empty paragraph (`home.js:341`, `:346`, `:390`, `:573`,
   `:575`, `:576`). There is no `.muted` rule. Those paragraphs get their grey from
   `.agenda-empty` or from `.list-empty`, so the class is doing nothing anywhere.
7. `mono`, on `.event-time` (`home.js:299`) and `.note-time` (`home.js:414`). There is no
   `.mono` rule. The mono look comes from `.event-time, .note-time` at `:404`.
8. `tone-0` through `tone-7`, added by `paintTone` (`home.js:133`) with the comment that they
   are "for the stylesheet to refine". The stylesheet has no `tone-N` rule.
9. `today`, added to `.agenda-day` (`home.js:383`) and again to `.day-head` (`home.js:240`).
   This one used to reach `.agenda-day.today .day-num`, which tinted the numeral olive. That
   rule is gone and nothing replaced it, so both classes now match nothing at all and today is
   marked entirely by the separately appended `.today-dot`. Either the classes go or the dot
   should be selected through them.
10. Also unstyled: `.text` inside a bubble (`conversation.js:71`), `.note-day`
    (`home.js:594`), `.event.now` (`home.js:289`; only `.now-label` inside it is styled), `live`
    added to `#clock` (`record.js:497`), and the `.label` span inside `#recBtn` (`:947`, which
    `.field .label` at `:784` does not reach).
11. `live`, toggled on the bubble container by `renderBubbles` (`conversation.js:138`) on
    every call from `record.js`. No rule reaches `#bubbles.live` or `.live` in that position.
    The recording tell that does work is `.recording` on `#transcriptPanel` (`:651`); this
    second one has never done anything.

### Principles the stylesheet now breaks

12. **Two font sizes outside the six.** `.agenda-nav-btn` sets 17px (`:321`) and `.row-more`
    sets 15px (`:461`). Both are glyph sizes rather than reading sizes and both have a case, but
    the comment at `:98-103` still says every `font-size` in the file is one of the six, and it
    is the one comment in this stylesheet that a reader is most likely to trust without
    checking. Either the two get tokens, or the comment gets a sentence admitting the
    exceptions.
13. **One box-shadow.** `.row-menu` (`:474`) carries `0 6px 20px rgba(28,28,26,.10)`. It is the
    only shadow in any of the three documents, and both of the others carry comments explaining
    that they earn their edge from a hairline "consistent with the rest of MIN, which has no
    shadows" (`notify.html:30-34`, `indicator.html:25-29`). Those comments are now wrong. A
    popover over a scrolling list is the one place a shadow genuinely earns its keep, so the
    honest fix is probably to keep it and rewrite the claim, not to remove it.
14. **Two status lines, two treatments.** `#status` in the note bar (`:762-766`) is mono at
    `--lh-title`; `#homeStatus` in the ask bar (`:445-448`) is sans at `--lh-ctl`. They share
    the same `.good` and `.warn` colour vocabulary and do the same job. "Mono is for anything
    measured" covers the note bar's clock-adjacent messages and arguably not home's, but nothing
    records that as a decision, and a reader comparing the two rules cannot tell which is the
    accident.

### Gaps in the rendered-markdown styles

15. `md.js` can emit `<h5>`. Its heading rule is
    `Math.min(heading[1].length + 1, 5)` (`md.js:59`), so `####` renders as `h5`, and `.doc`
    styles `h2`, `h3` and `h4` only (`:566`, `:571`). A four-hash heading in a pasted write-up
    falls to the browser default: bold, roughly 13px, wrong margins, no letter-spacing, and
    smaller than the body text around it.
16. `md.js` also emits `<em>` (`md.js:21-22`), which `.doc` does not mention. Browser italic is
    probably right, but it is unstated where `strong` is stated at `:576`.
17. `md.js` exports `renderTranscript` (`md.js:113`), which emits `p.line`, `span.ts` and
    `span.who.you|.them`. Nothing imports it, and `.doc` has no rule for any of those three
    classes. Either the export is dead or the styles are missing; today it is the export.
18. The comment at `:563` says `.doc` is "for write-ups and read-mode notes". The `doc` class
    appears on exactly one element, `#writeUp` (`:902`), and `record.js:873` is the only caller.
    Read-mode notes do not exist yet.

### Colour and contrast defects

19. `--ink-3` `#8a8a82` is the most-used colour in the file at 3.2:1 on the canvas, 3.5:1 on
    cards and 3.1:1 on the rail, nearly all of it at 12px. It fails 4.5:1 everywhere it is used
    as text. `#6e6e68` would clear 4.5:1 on all three grounds (4.8:1, 5.1:1, 4.6:1) without
    changing the feel; that is a one-line change with a wide blast radius, so it wants a
    deliberate pass rather than a drive-by.
20. `--accent-ink` `#788c15` is below 4.5:1 on all three grounds (3.5:1, 3.8:1, 3.4:1) and is
    used as text on `.now-label`, `.doc a`, `#status.good`, `#homeStatus.good`,
    `.fieldRow .result.good` and `.kv .v a`. `--accent` `#5b6f00` clears 4.5:1 on all three,
    which suggests the two roles are the wrong way round for text on light: the fill colour is
    the readable one.
21. `#recBtn.rec-on` puts `--danger` on `--danger-soft` at 4.1:1, and its hover drops that to
    3.8:1. A hover state that is less legible than its rest state is backwards.
22. The `.tile` initial is 14px at weight 600 on tone backgrounds ranging from 4.1:1 (sand) to
    6.0:1 (stone). Sand and clay fall short of 4.5:1.
23. `--hairline` on `--surface` is 1.2:1. That is a decision for a rule you feel rather than
    read, but it means the border on `.btn` is nearly invisible until hover moves it to
    `--ink-3`, and a resting button on the canvas is close to a floating label.
24. `.today-dot` (`:366`) is `--danger`. Everywhere else in the file `--danger` means a warning,
    a live recording or a destructive menu item, and today in the agenda is none of those. It
    used to be `--accent`, which is what the principle about olive meaning "captured or live"
    was written against. The dot reads well and the comment above it (`:359-363`) defends the
    dot being the only marker, but it says nothing about the colour, so the strongest semantic
    in the palette is currently spent on a date.

### Untokenised literals

25. `#fff` twice: the `.tile` `--tone-ink` fallback (`:432`) and `#recBtn` colour (`:748`).
    There is no white text token, even though `--surface-raised` is `#ffffff` and is already
    used as a text colour on `.btn.primary` (`:282`). Two names for the same white, one of them
    a fill token doing a text job.
26. `#000` twice on `.btn.primary:hover` (`:285`), a darker step past `--ink` with no token. A
    third copy now lives in `notify.html` (`:143`), which inherited the literal along with the
    button.
27. `#4f6100` twice on `#recBtn:hover` (`:751`), a darker olive than `--accent` with no token.
28. `#f2d6c8` on `#recBtn.rec-on:hover` (`:759`), a darker step past `--danger-soft` with no
    token.
29. Two ink alphas written out longhand because there is no token for either and `color-mix` is
    used nowhere in the file: `rgba(194,65,12,.35)` on `#recBtn.rec-on` (`:757`), which is
    `--danger` at 35 percent, and `rgba(28,28,26,.10)` in the `.row-menu` shadow (`:474`), which
    is the same ink as `--rail-hover` and `--rail-active` at a third alpha.
30. `880px` in `#viewHome > .col` (`:233`). It is a second reading measure sitting beside
    `--col` with no token and no relationship to it, and it is the number that decides how wide
    the agenda gets.
31. A flat line-height of `1` written as a literal in three rules, `.day-num` (`:347`),
    `.agenda-nav-btn` (`:321`) and `.row-more` (`:461`), where `--lh-ctl` says exactly that and
    is used for it 25 times elsewhere. `.day-stack` adds a fourth value, `1.25` (`:351`), that
    exists nowhere else.
32. Thirteen of the sixteen tone palette values (`home.js:26-35`) exist nowhere in the
    stylesheet. A designer reading `index.html` alone will not know they are in the product.

### Structural drift

33. `#topbar` pads at `0 20px` (`:207-216`) and then overrides its right padding with a calc off
    `env(titlebar-area-width)` so the "+ New note" button clears the Windows caption buttons.
    That is a good reason for the override, but it means the button is positioned against the
    window controls while everything under it is positioned against a centred column, and home's
    column is now 880px wide against the note view's 640px. The button lines up with neither.
34. The comment block at `:234-237` explaining why `.view > .bar` is a direct-child selector
    sits above the scrollbar comment and the six scrollbar rules, not above `.view > .bar`
    itself at `:253`. It reads as an explanation of the scrollbars.
35. `.event:focus-visible` (`:375`) declares exactly the same outline and offset as the global
    `:focus-visible` (`:136`) it is already inheriting. It is not wrong, but it is the kind of
    duplicate that survives a token change in one place and not the other.
36. The `<kbd>` inside the empty note list (`home.js:578`) has no rule reaching it. The only
    `kbd` rule is scoped `#searchPill kbd` (`:157`), so that one renders in the browser's
    default monospace at the browser's default size, outside the type scale.
37. The Archivo `@font-face` comment says "One variable file carries 400, 500 and 600" (`:60`),
    but the rail wordmark asks for 700 (`:190`). `fonts/README.md` says the same thing and is
    one weight behind for the same reason.
38. Eleven rules set letter-spacing with no token and no stated rule about when tracking
    tightens or opens. `.02em` alone appears in five of them.
39. The IBM Plex Mono 500 file (14,888 bytes) is downloaded for one rule, `#clock` (`:753`).
    Neither of the other two windows uses it. That is a real cost for one element; either more
    mono should be 500 or that one should be 400.
40. The two clickable rows disagree about focus. `.event:focus-visible` keeps the global 2px
    `--accent-ink` ring (`:375`), while `.note-row:focus-visible` sets `outline:none` and shows
    the hover fill instead (`:429`). Both are `role="button"` rows built by `home.js` from the
    same idea, so a keyboard user gets a ring on one list and a wash on the other.

## Working on this system

1. Read the values out of `app/index.html` before changing anything here. Its tokens are in one
   `:root` block at `:80-124` and there is no external stylesheet: the whole design system is
   the single inline `<style>` at `:28-800`.
2. Reference token names, not hex values. If a value has no token, that is a signal it should
   get one, and items 25 to 32 above are the current backlog.
3. If you change a colour, a radius, a font size, a line-height or `--mono`, check whether
   `indicator.html:40-51` or `notify.html:50-60` copies it. Twenty-four values are duplicated
   across those two by hand and nothing will tell you if they drift.
4. If you add a class in `home.js`, `record.js` or `conversation.js`, add its rule in the same
   commit or do not add the class. The list at items 6 to 11 is what happens otherwise.
5. If you remove a component, grep this file for its name before you finish. The last meter to
   leave the note bar was named in five places here.
6. Before adding a colour, ask whether the thing you are marking is captured or live. If it is
   neither, it is grey.
