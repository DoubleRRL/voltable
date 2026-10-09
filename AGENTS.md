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
the badge area says "Writing…", and once settled each figure and citation sits
under the answer it belongs to. There is no right-hand rail; the conversation
is a single `max-w-3xl` column so an evidence column can never squeeze the
answer or orphan the citations from their turn. And a not-covered answer
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
carousel owns only timing. Dots are inert mid-flight, presses disabled
mid-flight, and `beginFlight` parks focus on the region before anything moves —
without that, a keyboard user who tabs to the dots leaves `paused` true and
freezes a half-scattered figure on screen indefinitely. Pausing freezes the
timeline rather than cancelling it. One figure at a time at ~200px
(`FigureCarousel`), pausing on hover and on focus-within. Under reduced motion
the carousel never mounts — the static three-up row renders instead so every
figure stays reachable with zero motion. Empty state only; the conversation
view never shows figures unasked.

**The composer is a pill that opens, not a box.** The resting empty-state
field is 220×~59px of placeholder ("Ask away") — barely bigger than the text —
and springs to 300px with a two-row textarea on focus (spring 400/25/1.5,
the prompt-box shell this reverses-engineers), collapsing back once the draft
is empty. Collapsed it is one line with no footer and tightened padding all
the way down (card, inner, and the vendor container's own padding, each
scoped to the collapsed state); the send control is hidden on an empty draft
anyway, so the row is dead height — but never while busy, because the footer
carries Stop mid-stream. Planner prompts are short; the field stays small
because it is used small. The SEND ARROW is a state indicator, not a bloom:
it rests hidden until there is something to send. It rides 160ms, a measured
audit token matching the moderate tier's timescale. There is no field halo —
it was tried and rejected.

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
