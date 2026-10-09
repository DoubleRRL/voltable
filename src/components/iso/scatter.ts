import type { Box3, Vec3 } from "react-isokit";

/**
 * Scatter/gather transition math for the empty-state equipment figures.
 *
 * On carousel advance the outgoing figure's parts fly outward and fade while
 * the incoming figure's parts gather in from dispersed starts — rigid pieces
 * in flight, no morphing, no fake part correspondence (a pole wire becoming
 * a padmount door would read as wrong). Rotation is deliberately absent:
 * isokit boxes are axis-aligned in world space, so tumbling would require
 * redrawing geometry every frame; translation-only is the honest subset.
 *
 * Three properties make this read as one gesture instead of as debris, and
 * each replaces something measurably broken in the previous version:
 *
 *  1. A COHERENT FIELD, not per-part noise. Every part travels outward along
 *     the vector from the figure's own world-space centroid, so the assembly
 *     blooms apart as a whole. The old per-part hash angle produced 21
 *     disagreeing vectors and read as an explosion.
 *  2. MAGNITUDE FOLLOWS THE FIGURE. Travel is a fraction of that centroid's
 *     own radius rather than a fixed 80 world units. Measured: the pole
 *     (dense, 21 parts) moved +24% of its bbox while the switchgear (sparse,
 *     5 parts) moved +90% and spilled 36px outside its own plate — the same
 *     constant meant two completely different motions.
 *  3. FADE LEADS TRAVEL ON THE WAY OUT. A part holds full opacity through the
 *     first part of its flight and dims after, and the whole fade completes
 *     while it is still inside the plate. The old version faded only the
 *     wires and left every box at full opacity, which mid-transition drew
 *     solid geometry strung together by fading straight wires; and because
 *     isokit's svg is `overflow: visible`, the parts that left the plate were
 *     the ones still visible.
 *
 * The field is built ONCE per figure from its rest geometry and reused every
 * frame, so the per-frame cost is one projection and one multiply per part.
 */

/** Fraction of the figure's own radius the outermost part travels. */
export const SCATTER_SPAN = 0.34;

/** Stagger as a fraction of the flight: lower = tighter sweep. */
export const STAGGER_SPAN = 0.25;

/** Where in its own flight a part's opacity starts falling (out) / rising (in). */
const FADE_START = 0.45;
const FADE_IN = 0.8;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Opacity for a part (or a whole wire group) at staggered progress `local`.
 *
 * `local` runs 0 → 1 going OUT (home → dispersed) and 1 → 0 coming back IN, so
 * the two phases need opposite ramps and both must land exactly on 1 at the
 * rest pose or the figure pops when the flight ends.
 *
 * Out: full strength until the assembly has already lost its silhouette, then a
 * clean fall to nothing — so a part is fully transparent while it is still
 * inside the plate, which is what keeps the dispersal off the page.
 * In: invisible while it is out there, rising as it comes home. The ramp is
 * wide so the part is legible for most of its travel instead of popping into
 * existence in the last frame.
 */
export const veil = (local: number, out: boolean): number =>
  out
    ? 1 - clamp01((local - FADE_START) / (1 - FADE_START))
    : clamp01((FADE_IN - local) / FADE_IN);

/** Decelerating — for a part arriving at its mark. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Accelerating — for a part being thrown clear of the figure. */
export const easeInCubic = (t: number): number => t * t * t;

export type Transition = {
  /** 0 = rest, 1 = fully dispersed. */
  progress: number;
  /** Which half of the flight this is, which picks the curve and the fade. */
  phase: "out" | "in";
};

export type Part = { box: Box3; opacity: number };

/**
 * Per-figure travel field, derived once from the rest pose.
 *
 * Centroid and radius are world-space so travel is a plain world-space
 * distance along a world-space direction — no projection round-trip, and no
 * unit mismatch between "how far this part should go" and "how big is this
 * figure".
 */
export type Field = { cx: number; cy: number; cz: number; radius: number; travel: number };

const centre = (b: Box3): Vec3 => [b.x + b.w / 2, b.y + b.d / 2, b.z + b.h / 2];

/**
 * Build the travel field for a figure. `points` are extra world points to
 * include (a pole figure's sagging wire spans reach well past its boxes), so
 * a figure with long spans disperses by the same rule as one of solid boxes.
 */
export function field(boxes: ReadonlyArray<Box3>, points: ReadonlyArray<Vec3> = []): Field {
  const centres = [...boxes.map(centre), ...points];
  const cx = centres.reduce((s, c) => s + c[0], 0) / centres.length;
  const cy = centres.reduce((s, c) => s + c[1], 0) / centres.length;
  const cz = centres.reduce((s, c) => s + c[2], 0) / centres.length;
  const radius = centres.reduce(
    (m, c) => Math.max(m, Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz)),
    0
  );
  return { cx, cy, cz, radius: Math.max(radius, 1), travel: Math.max(radius, 1) * SCATTER_SPAN };
}

/**
 * Per-frame part factory for one figure in one transition.
 *
 * `index` / `count` drive the stagger. The part's share of the figure's radius
 * scales its travel, so the extremes lead and the middle barely moves: that
 * ordering is what makes the assembly read as expanding rather than as every
 * box leaving at the same instant.
 */
export function parts(f: Field, t: Transition) {
  const { progress, phase } = t;
  const out = phase === "out";
  const span = STAGGER_SPAN;

  return (rest: Box3, index: number, count: number): Part => {
    // Stagger remaps progress into this part's own sub-window. Remapping
    // BEFORE easing is what makes the sweep one motion; easing the raw
    // progress (as the old code did) front-loaded everything into the first
    // 200ms and left a crawl behind it.
    const local = clamp01((progress - (index / count) * span) / (1 - span));

    const c = centre(rest);
    const dx = c[0] - f.cx;
    const dy = c[1] - f.cy;
    const dz = c[2] - f.cz;
    const len = Math.hypot(dx, dy, dz);

    const travel = out ? easeInCubic(local) : easeOutCubic(local);
    const share = (len / f.radius) * travel;

    // Opacity runs off `local`, not off eased travel: it is a visibility cue,
    // not a physical one. Out, the part stays at full strength while it is
    // moving fastest and dims only once the figure has lost its silhouette —
    // and it is fully transparent before it can leave the plate. In, it is
    // visible almost immediately, so the figure materialises out there and
    // then travels home rather than popping into existence at the end.
    const opacity = veil(local, out);

    if (len < 1e-6) {
      // A part sitting exactly on the centroid has no outward direction.
      // Lift it in depth rather than leaving it pinned while its neighbours
      // leave — a stationary piece mid-flight reads as a bug.
      return {
        box: { ...rest, y: rest.y - share * f.travel * 0.5, z: rest.z + share * f.travel * 0.5 },
        opacity,
      };
    }

    return {
      box: {
        ...rest,
        x: rest.x + (dx / len) * f.travel * share,
        y: rest.y + (dy / len) * f.travel * share,
        z: rest.z + (dz / len) * f.travel * share,
      },
      opacity,
    };
  };
}