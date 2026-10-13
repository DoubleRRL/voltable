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
 * Sidewalk anchor guy, after the ADS 10 Appendix 10–3 worked example (p140).
 *
 * Where no room exists for a full lead, the guy leaves the arm and lands on
 * a horizontal sidewalk brace instead of an anchor in the ground: pole, arm,
 * guy with its strain insulator, brace strut, anchor head at the brace end.
 * The brace is what tells this apart from a plain anchor guy — a strut in
 * the air, not a rod in the earth. No dimensions drawn: the sheet's 35/11/8
 * feet are example values, not quotable geometry.
 */
const POLE: Box3 = { x: 118, y: 92, z: 30, w: 16, d: 16, h: 120 };

/** Arm the guy leaves from. */
const ARM: Box3 = { x: 96, y: 90, z: 138, w: 30, d: 12, h: 8 };

/** Sidewalk horizontal brace carrying the guy's foot. */
const BRACE: Box3 = { x: 60, y: 90, z: 48, w: 60, d: 10, h: 8 };

/** Strain insulator riding in the guy. */
const INSULATOR: Box3 = { x: 78, y: 90, z: 91, w: 8, d: 8, h: 12 };

/** Anchor head where the guy meets the brace end. */
const ANCHOR: Box3 = { x: 56, y: 90, z: 44, w: 10, d: 12, h: 14 };

/** Grade the pole stands on. */
const GRADE: Box3 = { x: 40, y: 88, z: 22, w: 110, d: 20, h: 8 };

/** Guy from arm to brace end, straight and taut. */
const GUY_PTS: Vec3[] = [
  [100, 92, 138],
  [88, 92, 111],
  [76, 92, 83],
  [64, 92, 56],
];

const WALK_BOXES = [POLE, ARM, BRACE, INSULATOR, ANCHOR, GRADE];
const WALK_WIRES = [...GUY_PTS];
const WALK_FIELD = field(WALK_BOXES, WALK_WIRES);

/** Grade hatching. */
const HATCH =
  Array.from({ length: 12 }, (_, i) => `M${5 + i * 8} 8L${9 + i * 8} 0`).join(" ");

/**
 * Sidewalk anchor guy.
 *
 * ADS 10 Appendix 10–3: guy off the arm, insulator in line, foot on the
 * brace end instead of in the ground. Pressing flashes the anchor head;
 * the flash is the whole output.
 */
export function SidewalkGuyFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 6;
  const at = transition ? parts(WALK_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(GUY_PTS)} />
    </g>
  );

  return (
    <Plate
      label="Sidewalk anchor guy"
      aspect={1}
      fit={[...WALK_BOXES, ...GUY_PTS]}
      theme="system"
      className="iso-figure iso-sidewalk"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={9} cy={9} r={6} />}
        front={<path className="ik-detail" d="M4 8V114 M12 8V114" />}
      />
      <ScatterBox at={at} rest={ARM} index={1} count={N} r={2}
        front={<path className="ik-detail" d="M1 4H29" />}
      />
      <ScatterBox at={at} rest={BRACE} index={2} count={N} r={2}
        front={<path className="ik-detail" d="M1 4H59" />}
      />
      <ScatterBox at={at} rest={INSULATOR} index={3} count={N} r={2}
        front={<path className="ik-detail" d="M0 3H8 M0 9H8 M4 0V12" />}
      />
      <Press
        label="Flash the brace anchor head"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={ANCHOR} index={4} count={N}
            r={2}
            front={
              <circle
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                cx={5}
                cy={5}
                r={3.5}
              />
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={GRADE} index={5} count={N} r={2}
        front={<path className="ik-detail" d={HATCH} />}
      />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
