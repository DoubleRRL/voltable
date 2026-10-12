"use client";

import { useState } from "react";

import {
  Plate,
  Press,
  path as makePath,
  type Box3,
  type Vec3,
} from "react-isokit";

import { field, parts, veil, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

/**
 * Triple-eye anchor guying, after PLM Fig 1 (p70, resultant guying load).
 *
 * The drawing shows three guys leaving the pole at three heights and landing
 * on one triple-eye anchor, with the lead length dimensioned along the
 * ground. The guys are straight taut lines — no sag, no coils — and the
 * anchor eye sits at grade with the rod running below it. What makes it read
 * as guying rather than rigging is the fan of three to one eye.
 */
const POLE: Box3 = { x: 120, y: 92, z: 30, w: 16, d: 16, h: 130 };

/** Grade band the pole and anchor bear on. */
const GROUND: Box3 = { x: 0, y: 88, z: 22, w: 150, d: 20, h: 8 };

/** Triple eye at grade taking all three guys. */
const EYE: Box3 = { x: 28, y: 92, z: 30, w: 10, d: 10, h: 8 };

/** Anchor rod running below grade. */
const ROD: Box3 = { x: 30, y: 92, z: 6, w: 6, d: 6, h: 24 };

/** The three guys, three heights, one eye — straight taut spans. */
const GUY_1: Vec3[] = [
  [128, 92, 156],
  [97, 92, 116],
  [64, 92, 76],
  [33, 92, 36],
];
const GUY_2: Vec3[] = [
  [128, 92, 126],
  [97, 92, 96],
  [64, 92, 66],
  [33, 92, 36],
];
const GUY_3: Vec3[] = [
  [128, 92, 98],
  [97, 92, 77],
  [64, 92, 57],
  [33, 92, 36],
];
/** Lead length dimensioned along grade, as Fig 1 dimensions it. */
const LEAD: Vec3[] = [
  [33, 92, 26],
  [65, 92, 26],
  [96, 92, 26],
  [128, 92, 26],
];

const GUY_BOXES = [POLE, GROUND, EYE, ROD];
const GUY_WIRES = [...GUY_1, ...GUY_2, ...GUY_3, ...LEAD];
const GUY_FIELD = field(GUY_BOXES, GUY_WIRES);

/** Grade hatching. */
const HATCH =
  Array.from({ length: 18 }, (_, i) => `M${4 + i * 8} 8L${8 + i * 8} 0`).join(" ");

/**
 * Triple-eye anchor guying.
 *
 * PLM Fig 1: three guys off the pole at three heights, one eye, the lead
 * dimensioned along grade. Pressing flashes the anchor eye; the flash is
 * the whole output.
 */
export function GuyAnchorFigure2({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 4;
  const at = transition ? parts(GUY_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(GUY_1)} />
      <path className="ik-line" d={makePath(GUY_2)} />
      <path className="ik-line" d={makePath(GUY_3)} />
      <path className="ik-line" d={makePath(LEAD)} />
    </g>
  );

  return (
    <Plate
      label="Triple-eye anchor guying"
      aspect={1}
      fit={[...GUY_BOXES, ...GUY_WIRES]}
      theme="system"
      className="iso-figure iso-guyanchor"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={9} cy={9} r={6} />}
        front={<path className="ik-detail" d="M4 8V124 M12 8V124" />}
      />
      <ScatterBox at={at} rest={GROUND} index={1} count={N} r={2}
        front={<path className="ik-detail" d={HATCH} />}
      />
      <Press
        label="Flash the anchor eye"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={EYE} index={2} count={N}
            r={2}
            front={
              <circle
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                cx={5}
                cy={4}
                r={3}
              />
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={ROD} index={3} count={N} r={2}
        front={<path className="ik-detail" d="M3 0V24" />}
      />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
