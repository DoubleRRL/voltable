<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Fluid Functionalism

Settled choices about how this app moves. Do not re-raise these.

**Never edit an installed `src/components/ui/*` file to match;** it is
overwritten on the next `--overwrite` install.

**The empty state is the composer and nothing else.** No greeting, no title
block, no starter questions, no footer chrome in the composer ("ESR · 282
pages", "Enter sends…"). Trained planners using an internal tool need no
onboarding, and every line of it was filler. The composer's placeholder does
the only guiding work.

**No explanatory subheadings anywhere.** Marketing copy describing what the app
does was cut from the empty state and the header. The app name, the controls and
the citations are the interface. Any new copy must state something a user needs
in order to decide, not describe a feature.

**One refusal, stated once.** When the ESR does not cover a question, three
things are visible: the badge reads `Not in ESR`, the answer prose is one line
about what to do next, and the notice gives the nearest chapters. That is the
whole treatment. It was once five surfaces — badge, badge tooltip, headline,
"read full answer" disclosure, and a notice that restated the verdict — and it
read as several separate problems rather than one finding. The grounding badge
has no tooltip at all: a tooltip here could only explain *how* the verdict was
reached, which is the software's business, not the planner's.

**No electrical phase (1-phase / 3-phase) filter.** Removed end to end —
types, storage columns and indexes, retrieval options, pipeline params, cache
keys, and the UI toggle. It was never anything but a no-op: nothing outside the
deleted toggle set it, so every `matchesPhaseFilter` call compared against
`null` and returned every row. Do not reintroduce it.

**The ESR opens in a dialog, never a new tab.** Each citation row shows
`Page N` and opens `/esr.pdf#page=N` in an in-app dialog beside the answer.
Handing a planner a 28 MB PDF in a new tab loses the question, the answer and
the transcript — on a live call there may not be time to get back.

**Figures are thumbnails, not posters.** A diagram renders inline at 112px
with a page badge; activating it opens `FigureLightbox` — the full-resolution
crop, its OCR text, and a corner handle that drag-resizes the panel, because
on a live call the planner has to read a dimension off the drawing and a
thumbnail cannot carry one. The lightbox lives outside `Dialog` on purpose:
the stock dialog is fixed-size and there is no resizeable-modal primitive to
install, so the panel is a thin custom surface that still speaks the system
(surface tokens, container radius, spring tiers for mount, 1:1 pointer
tracking for the drag itself).

**Saved answers are a dialog, not a sidebar and not a tab pair.** One route,
opened from the floating edge cluster as `Dialog size="lg"`; a saved answer is
a destination you scroll through, not a mode the page switches into. Saves live
in `localStorage` with their citations intact, because a bookmark that lost its
citations would be a liability rather than a shortcut.
The `TabsSubtle` idea died with the header bar.

**An answer reads top to bottom: text, figures, sources.** The direct answer
and prose come first, then the figure thumbnails, then a "Sources" section
with the citations — the shape every modern answer UI converged on. The
retrieval trail ("How this was found") used to sit above the answer and read
as a second answer competing with the first, so it is gone: while streaming
the card shows the thinking orb (morphing circle⇄infinity, one "Thinking…"
announcement, static under reduced motion), and once settled each figure and
citation sits under the answer it belongs to. There is no right-hand rail; the conversation
is a single `max-w-3xl` column so an evidence column can never squeeze the
answer or orphan the citations from their turn. Refusal copy is
planner-facing only: the notice once read "Don't quote a number from this",
which is an instruction to the model leaking into the UI — it now says what
matched and where to look, nothing else. And a not-covered answer
shows no Sources section at all: near-miss chunks are handed back as
citations, not as evidence, and listing them under a "Sources" header claims
support they explicitly do not give. The refusal stays three surfaces — badge,
one-line prose, nearest-chapter notice — never four.

**No verdict while streaming.** An assistant message starts life with no
evidence, and its default grounding is "none" — so the first paint showed a
red "Not in ESR" badge next to "Writing…", which read as the answer before
there was one. While streaming the badge is a neutral gray "Checking…"; the
verdict renders only once the stream settles.

**Coded table cells never go to the model alone.** A table verdict is often a
single letter ("U") defined by a legend line on the same page ("U =
Unacceptable") that the question's terms never match — so retrieval returned
the table without its key and the model expanded the code from prior
knowledge, then misread the row on top of it (it attached row 1's `A` to
`301A` while quoting the row that says `U`). Three fixes, all in
`src/lib/rag`:

- Tables travel with their key and legend. The clean markdown table is pulled
  in behind its OCR sibling through the shared pair group (the OCR flow drops
  the code column into unreadable order), and same-page short text rides
  behind the table — positioned as attachments, capped, and repositioned up
  next to the table when BM25 strands them below the top-K cut. The OCR
  sibling is dropped when the markdown subsumes it so the pair does not eat
  two of the four context slots.
- The prompt forbids expanding a code from anything but a legend in context.
- `resolveTableCode` answers outright when the question names the row key and
  exactly one row plus its legend are in context: no ~7s model call, and the
  row and legend line are quoted verbatim (the fuzzy quoter would balloon
  them to the whole table). Anything ambiguous falls through to the model.
- Retrieval queries resolve anaphora: pronouns (`it/they/them/…`) are never
  self-contained, so an anaphoric follow-up ("what kind of panels need it
  then?") searches the tail conversation (last user turns plus the last
  assistant answer, where the referent lives) instead of searching the
  dangling words literally — which once answered test blocks with handles.
  Bare-relative-pronoun "that" is excluded on purpose (it false-triggers on
  self-contained questions); short questions merge regardless.
- Every measurement in a model answer must appear in a cited quote — same
  number, same unit, no cross-unit conversion (a "2.5 feet" backed only by a
  "30 in" riser dimension is fabrication, not support). Word-numbers count
  ("three feet" meets "3'"), question-echoed numbers are exempt, unparseable
  values never flag. A violation caps the verdict at partial, drops a headline
  that states one, and says so in the prose. Quoteless citations are dropped
  outright: a source with no verifiable quote lends authority to whatever the
  prose claims next to it.
- Approval questions require an explicitly permitting or prohibiting chunk; a
  nearby topic is never permission, and a stated requirement the question
  would violate means no.
- Coverage reads the section heading with the chunk text (a table chunk is
  stripped of context at ingest — its text starts at the separator row), and
  the alias table covers approval language (approved/acceptable/
  acceptability) and pools (pool/pools/swimming) by the same precedent as the
  unit synonyms. Question filler (how/does/many/need/…) is stopped out of the
  FTS query because it only ever drags the coverage denominator.
- Planner shorthand never reaches the tokenizer raw: `p/l` → property line,
  `o/h` → overhead, `u/g` → underground, and prime marks expand (`2'` →
  2 feet) on both the question and the chunk side, so "3'-0"" meets "3 feet"
  on the shared token. Bare `oh`/`ug` and dotted forms (`o.h.`) expand the
  same way. Crew abbreviations ride the alias table both directions
  (short-to-long for typed shorthand like `pri`/`sec`/`svc`/`str`/`pad`/
  `eqmt`, long-to-short for OCR and figure callouts that abbreviate); `str`
  maps to structure and street both, ranking sorts out which was meant. Pole and
  structure numbers (`pole#45218`, `str#123`) tokenize to noun plus digits —
  the digits match nothing in the ESR today and are left intact on purpose
  as the future GIS hook, for a tool harness to resolve against real assets.
- Ranking is MMR (λ=0.7) over chunk-text similarity — never over matched
  question tokens, which punished a setback rule for sharing the words
  "property line" with a lateral figure stating different facts. Tables are
  exempt (glossary tables are not: they define terms but answer nothing).
- The coverage gate has a joint alternative: top-1 below bar but top-4
  jointly covering around an anchor still passes. Approval questions boost
  normative rules with measurements (same weight as the figure prior).
- A markdown table with real data rows subsumes its OCR sibling; a
  title-and-footer stub yields to the OCR flow that actually carries the
  numbers. Either way the pair costs one context slot, and short text already
  above a table stays where BM25 put it.

**isokit motion tokens are vendor-owned.** The FF audit flags `260ms`/`200ms`
transitions inside figure SVGs and measured heights like `20px`/`44px`/`48px`
— those are `react-isokit/styles.css` and SVG user units, not app code or
controls. Do not override them for audit cleanliness; the kit's press spring
and glow timings are its own system, the same way `src/components/ui/*`
timing belongs to its library. The app's own additions (carousel transitions,
dots, mount entrances, composer bloom) stay on `spring.*` tiers with
transform/opacity/blur only; the bloom's 160ms CSS fade sits on a measured
audit token for the same reason.

**Empty-state figures rotate by scatter/gather, not crossfade.** On advance
the outgoing figure's parts are thrown clear of the figure's own centroid and
fade, while the incoming figure's parts materialise out where they start and
gather in. Rigid pieces in flight — no morphing, no fake part correspondence
(a pole wire becoming a padmount door would read as wrong), no tumbling
(isokit boxes are axis-aligned, so rotation would mean redrawing geometry every
frame). Three properties are load-bearing, each replacing something measured
as broken:

- **A coherent field, never per-part noise.** Every part travels along the
  vector from the figure's world-space centroid. A hash-seeded random angle per
  part looks like an explosion because nothing in it agrees.
- **Magnitude follows the figure.** Travel is `SCATTER_SPAN` (0.34) of that
  centroid's radius, not a fixed 80 world units. With a constant, the pole
  moved +24% of its bbox while the switchgear moved +90% and spilled 36px
  outside its own plate — one constant, two unrelated motions.
- **The fade leads the travel on the way out.** A part holds full opacity
  through the first part of its flight and dims after, reaching zero while it
  is still inside the plate. Fading only the wires left every box at full
  opacity, which mid-flight drew solid geometry strung together by fading
  straight wires, and — because `.ik-plate > svg` is `overflow: visible` —
  left the escaping parts as the only visible ones.

Curve direction matters per phase: `easeInCubic` out (accelerating away is a
throw), `easeOutCubic` in (decelerating into place is an arrival). Stagger
remaps progress into each part's sub-window *before* easing; easing raw
progress front-loads the whole figure into the first 200ms and leaves a crawl.

The two phases OVERLAP (`OVERLAP_MS`), they never cut. Sequenced phases left a
frame where the plate held a fully dispersed, fully opaque figure — the exact
"chaos" frame that made the first version unreadable. Whole flight is 500ms on
the slow tier's timescale, against 5.5s dwell; it is ambient, not attention-
seeking. Frames are scheduled only while a flight is live.

Contract for figure files: accept an optional `transition` prop
(`{ progress, phase }`); build a `Field` once at module scope with `field()`,
pass it to `parts()` each frame, and render boxes through `ScatterBox`. The
carousel owns only timing. There are no dots: with ten figures the strip
reads as clutter, so rotation is dwell-only and the sr-only live region still
announces each figure. Presses are inert mid-flight (each figure disables its
Press whenever `transition` is defined), and `beginFlight` parks focus on the
region before anything moves. Pausing freezes the
timeline rather than cancelling it. One figure at a time at ~200px
(`FigureCarousel`), pausing on hover and on focus-within. Under reduced motion
the carousel never mounts — the static wrapped row renders instead so every
figure stays reachable with zero motion (a `useSyncExternalStore` mount guard
keeps SSR and first client render identical, or React 418s). Empty state only;
the conversation view never shows figures unasked.

**Figure accuracy comes from the manual, not from memory.** Every equipment
figure is drawn against a manual's own drawings, not just the ESR's
(`public/evidence/<manual>/fig-*.png`): round poles with grain caps, meter
boards on posts with burial, risers with sweeps into grade plus ground rods,
guys as taut wire to a rodded anchor with a guard. The three originally
approved figures stay. The seven that followed were drawn for equipment the ESR
does not depict — it has no guy anchor, no cutout, no recloser, no PME, no
dead-end pole — which is why they kept reading as wrong no matter how they were
redrawn. DOH carries the overhead construction standards (AC 345 double dead-end,
AC 350 dead-end with anchor guy, AC 370 anchor guy zone of proximity) and UGS
carries the PME structures (SS 540, SS 591, SS 587, SS 590). A figure without a
drawing in a manual behind it does not get drawn, which is why the recloser went:
no sheet in any of the five draws one. A steel stub pole is referenced in PLM
2-21 and the PLT training manual but never drawn, so it is not drawn here either. The scheme contract per figure
file: one `Plate`, a module-scope `field()`, `ScatterBox` parts numbered in
paint order with staggered indices, SVG `path` face details only, exactly one
`Press` whose sole output is a glow flash, disabled while `transition` is
defined, own `--chapter-hue`. Diagonals are drawn curves (boxes are
axis-aligned); wires fade unstaggered via `veil`. Verify rest geometry with
`shoot.isokit.mjs` against `next start` — never `next dev`, whose chunks do not
hydrate here.

**Five manuals, and a citation is not a page number.** The corpus is ESR, ADS,
DOH, PLM and UGS — 2,591 pages. Two consequences run through everything and
are not to be undone:

- **A page number is only unique inside a manual.** Page 20 exists in all five.
  Every lookup that takes a bare page number and reads evidence is a latent
  cross-manual mix-up, so `getShortTextChunksByPages` and
  `getFigureEvidenceForPages` take `{ docId, page }` pairs. An ESR legend
  attached to a DOH table is worse than no legend: it is a confident wrong key
  for a code the reader then expands.
- **Two numbering schemes.** ESR, ADS and PLM number pages (`ESR 3-24`); DOH and
  UGS number standard sheets (`DOH AC 120 Sheet 2 of 2`) and have no page to
  cite at all. `src/lib/rag/docs.ts` holds the registry and `citeLabel()`
  composes from it. The PDF page index is never shown — it is an artefact of
  which pages were extracted and does not survive the next issue.

Every generated key is namespaced by manual id: asset ids, chunk ids, the
render cache, evidence paths, citation links. The render cache is the dangerous
one — a shared `p${page}.json` would silently serve ESR's page 73 OCR for DOH
page 73, which is wrong data rather than a visible failure.

**Page identity is read off the printed footer, not inferred.** Every manual is
one FrameMaker template, so `scripts/render/page-facts.py` reads the header and
footer bands by text-matrix position. It has to be positional: `extract_text()`
on these files emits the footer as unmerged fragments in arbitrary order. The
printed page label is then the dash-pair fragment nearest the literal `PAGE`
token, not the first dash-pair in the band — ESR section titles end in a
voltage, so "Underground Service Connections 0-600 V" otherwise reads as a page
label.

**The manuals are not in the app.** 212 MB of PDF against a code bundle of
tens of megabytes, and the extracted ADS/DOH copies are subsets whose page
numbers do not match the manual a planner holds — a bundled PDF would produce
citations that look checkable and are not. A citation resolves to manual + issue
+ printed label + exact verified quote + crop + a one-page derivative of that
page. `docs/evidence.md` has the full split; the bundle carries a size budget
that `build-app.sh` fails loudly against. Each manual's own classification
(`SCE Public` / `SCE Internal` / `SCE Confidential`) is on page one and in the
registry, so anything that redistributes a page is a decision made with it
visible.

**MinerU runs two at a time.** The parse server runs CPU inference on this box
(8 cores, 16 GB); it took three failed restarts and disabled itself when
over-committed, and `mineru server restart` is the fix when `engine_unavailable`
appears. Layout parse is the memory-hungry stage and is capped at two; render
and OCR are per-page and run fully parallel.

**The composer is a pill that opens, not a box.** The resting empty-state
field is 163×~59px of placeholder ("Ask away") — barely bigger than the text.
Growth is two-stage: focus opens it to 208px, the first text takes it to
320px once, and after that only height moves as the draft wraps (spring
400/25/1.5, the prompt-box shell this reverses-engineers). Keyed off the
draft, not focus, so tabbing away mid-draft never collapses it — and onBlur
already keeps focus while a draft stands. The footer row hides while the
field is empty — the send control is hidden on an empty draft anyway — but
never while busy, because the footer carries Stop mid-stream. 37px tall was
measured against and rejected: one text line is 36px and the vendor
container carries 16px of padding, so anything under ~50px clips text; the
remaining ~7px over the floor is an a11y node that stays.
Planner prompts are short; the field stays small because it is used small.
The SEND ARROW is a state indicator, not a bloom: it rests hidden until there
is something to send. It rides 160ms, a measured audit token matching the
moderate tier's timescale. There is no field halo — it was tried and
rejected.

**Verify UI changes against the staged runtime, never `next dev`.** `next dev`
in this repo serves SSR HTML whose client chunks do not resolve, so the page
renders and every handler is dead — a transition that "does nothing" and a
composer whose `data-draft` never flips are both what an unhydrated page
looks like. Build, stage, and boot `dist/stage/ESR Assistant.app/Contents/
Resources/runtime` on port 3001, and kill whatever is already holding the port
first: a leftover server answers `/api/health` while every probe silently hits
the stale build. Raw `node .next/standalone/server.js` is also unhydrated —
the standalone output does not carry `.next/static`.

**No header bar and no app title in the UI.** There is no `<header>`, no `h1`,
and no visible "ESR Assistant" string anywhere — the window chrome and the
browser tab already name the app. What the bar used to hold lives in a floating
edge cluster at top-right (Saved dialog trigger, New chat, theme toggle) so no
layout row is spent on chrome. Saved opens as a `Dialog size="lg"` because a
saved answer is a destination you scroll through, not a mode the page switches
into; the Ask/Saved tab pair died with the bar. The conversation keeps top
clearance (`pt-14`) so right-aligned user bubbles never slide under the cluster.

**Craft compliance rules for custom code.** Type always goes through
`typeClass(role)` — never raw `text-[length:...]` — so it follows the provider
instead of pinning the default step. No hand-written durations: library
components own their transitions, and custom elements drop `duration-*`
rather than inventing one. Small actions are library `Button
size="compact|icon"`, never hand-rolled `px/py` boxes; radii come from
`shape.*`, never raw `rounded-[Npx]`. Focus rings reference
`var(--focus-ring)` with no hex fallback. Link underlines are solid
(`decoration-current`), never opacity steps. `typeClass` without a provider
pins the default step — accepted deliberately: no `SizeProvider` wraps the
app, because density here is per-component (header/rail compact, transcript
default), not per-region. Page-stack gaps and card paddings stay as authored;
the ladder governs controls, rows, and type, not layout.
