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

**Saved answers are a dialog, not a sidebar and not a tab pair.** One route,
opened from the floating edge cluster as `Dialog size="lg"`; a saved answer is
a destination you scroll through, not a mode the page switches into. A sidebar
would take width the evidence rail already owns at `lg:w-80` and squeeze the
answer. Saves live in `localStorage` with their citations intact, because a
bookmark that lost its citations would be a liability rather than a shortcut.
The `TabsSubtle` idea died with the header bar.

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

**The composer has two separate things, deliberately.** The FIELD BLOOM is a
halo that radiates from the composer card on `:focus-within` — the field
lighting up. It lives on `.composer-field` (the card in `ChatApp`), not on
`.composer-bloom` (the input wrapper), because the halo must ring the visible
surface and the wrapper sits 12px inside it. It is a pseudo-element, so it
costs the vendor `InputMessage` nothing. The SEND ARROW is a state indicator,
not a bloom: it rests hidden until there is something to send. Both ride
160ms, a measured audit token matching the moderate tier's timescale.

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
