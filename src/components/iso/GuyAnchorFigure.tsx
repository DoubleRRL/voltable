"use client";

import { useState } from "react";

import {
  Plate,
  Press,
  curve,
  path as makePath,
  type Box3,
  type Vec3,
} from "react-isokit";

import { field, parts, veil, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

/**
 * Ground, as a slab only across the back of the scene.
 *
 * Two earlier attempts failed for the same reason and it is worth naming: a
 * solid soil box put the rod *inside* it, and a full-width thin slab still put
 * the rod *behind* it. In a view from above, anything below a solid is simply
 * not drawn — no amount of hatch detail gets around it. So the ground is a
 * strip at the back, the pole stands on it, and the guy runs forward off it to
 * an anchor that hangs below the grade line in open air.
 *
 * DOH AC 370-1: the guy ends at an insulator near grade with the anchor below.
 * Nothing of an anchor shows above ground but the wire end.
 */
const SOIL: Box3 = { x: 0, y: 108, z: -10, w: 250, d: 62, h: 10 };

const POLE: Box3 = { x: 34, y: 122, z: 0, w: 18, d: 18, h: 190 };

/** Crossarm the guy is bolted below. */
const ARM: Box3 = { x: 2, y: 124, z: 150, w: 82, d: 14, h: 12 };

/** Guy strain insulator, in the last run before the anchor. */
const INSULATOR: Box3 = { x: 186, y: 44, z: 18, w: 12, d: 12, h: 30 };

/**
 * The anchor rod: driven into the earth ahead of the ground strip, so it is
 * below the grade line and still in view. Its eye is where the guy turns onto it.
 */
const ROD: Box3 = { x: 188, y: 46, z: -54, w: 8, d: 8, h: 44 };
const EYE: Box3 = { x: 185, y: 43, z: -14, w: 14, d: 14, h: 9 };

/**
 * Guy from the bolt under the arm out to the anchor eye, per AC 370-1: it runs
 * down and away and stops at an insulator a clear distance from the pole. Taut
 * — a guy is tensioned hardware, not a span.
 */
const GUY_PTS: Vec3[] = curve(
  [54, 132, 138],
  [104, 100, 104],
  [150, 68, 60],
  [192, 49, 8],
);
const GUY_PATH = makePath(GUY_PTS);

const GUY_BOXES = [SOIL, POLE, ARM, INSULATOR, ROD, EYE];
const GUY_FIELD = field(GUY_BOXES, GUY_PTS);

/**
 * Guy wire and anchor, drawn from DOH.
 *
 * AC 370-1: a pole with an arm, the guy bolted to the pole below the arm and
 * running out to an anchor guy insulator held outside the pole's zone of
 * proximity. AC 340 Detail A: the strain insulator and its eye in the guy, with
 * the preform dead-end wrap on the wire.
 *
 * The anchor itself is below grade and is drawn as a cutaway through the soil,
 * because the cutaway is the only way an isometric can show where it is — which
 * is the fact that drawing it above grade got wrong. Pressing flashes the eye
 * where the wire turns onto the rod; the flash is the whole output.
 */
export function GuyAnchorFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 6;
  const at = transition ? parts(GUY_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = <path className="ik-line" d={GUY_PATH} />;

  return (
    <Plate
      label="Guy wire and anchor"
      aspect={1}
      fit={[...GUY_BOXES, ...GUY_PTS]}
      theme="system"
      className="iso-figure iso-guy"
    >
      {/* Ground: a thin slab hatched across its cut face, so the grade line
          reads as a cut and the anchor below it is in open air. */}
      <ScatterBox at={at} rest={SOIL} index={0} count={N}
        r={2}
        front={
          <>
            <path className="ik-detail" d="M0 2H250" />
            <path
              className="ik-detail"
              d="M10 7l6 -5 M40 7l6 -5 M70 7l6 -5 M100 7l6 -5 M130 7l6 -5
                 M160 7l6 -5 M190 7l6 -5 M220 7l6 -5"
            />
          </>
        }
      />
      <ScatterBox at={at} rest={POLE} index={1} count={N}
        r={7}
        top={<circle className="ik-detail" cx={9} cy={9} r={6.5} />}
        front={
          <>
            <path className="ik-detail" d="M5 8V184 M13 8V184" />
            {/* The bolt the guy hangs from, below the arm. */}
            <circle className="ik-fill" cx={9} cy={126} r={2} />
          </>
        }
      />
      <ScatterBox at={at} rest={ARM} index={2} count={N} r={3}
        top={<path className="ik-detail" d="M6 5H76" />}
      />
      <ScatterBox at={at} rest={INSULATOR} index={3} count={N} r={2}
        front={
          <>
            {/* Skins stack up an insulator; six is a legible shorthand. */}
            <path className="ik-detail" d="M0 3H12 M0 8H12 M0 13H12 M0 18H12 M0 23H12 M0 28H12" />
            <path className="ik-detail" d="M6 -3V3 M6 30V34" />
          </>
        }
      />
      <ScatterBox at={at} rest={ROD} index={4} count={N} r={2} />
      <Press
        label="Flash the anchor eye"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={EYE} index={5} count={N}
            r={2}
            front={
              <circle
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                cx={7}
                cy={4.5}
                r={3.2}
              />
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
