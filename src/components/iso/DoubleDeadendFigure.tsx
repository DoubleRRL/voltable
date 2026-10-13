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
 * Double dead-end arms with the line conductor, after ADS 10 Fig 10–20 (p130).
 *
 * The line arrives perpendicular to the arm face — along the line direction,
 * not along the arms — and terminates at one arm end on a dead-end eye. Kept
 * deliberately simple: arms, bolts, one conductor, one eye. No jumpers, no
 * insulator bells; the conductor itself is what tells this apart from bare
 * arming brackets.
 */
const POLE: Box3 = { x: 66, y: 90, z: 20, w: 18, d: 18, h: 130 };

const ARM_TOP: Box3 = { x: 8, y: 90, z: 120, w: 130, d: 12, h: 8 };
const ARM_BOT: Box3 = { x: 8, y: 90, z: 80, w: 130, d: 12, h: 8 };

/** Through-bolt clamping both arms to the pole. */
const BOLT: Box3 = { x: 71, y: 88, z: 76, w: 8, d: 20, h: 56 };

/** Dead-end eye on the top arm end taking the conductor. */
const EYE: Box3 = { x: 128, y: 90, z: 120, w: 10, d: 10, h: 10 };

/** The line conductor, arriving perpendicular to the arm face and plugging
 * down into the dead-end eye — descending approach so it reads as landing,
 * not passing under. */
const LINE_PTS: Vec3[] = [
  [133, 185, 146],
  [133, 152, 137],
  [133, 120, 129],
  [133, 92, 126],
];

const DEADEND_BOXES = [POLE, ARM_TOP, ARM_BOT, BOLT, EYE];
const DEADEND_WIRES = [...LINE_PTS];
const DEADEND_FIELD = field(DEADEND_BOXES, DEADEND_WIRES);

/**
 * Double dead-end arms with the line conductor.
 *
 * ADS 10 Fig 10–20: the conductor lands perpendicular on the arm-end eye.
 * Pressing flashes the dead-end eye; the flash is the whole output.
 */
export function DoubleDeadendFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 5;
  const at = transition ? parts(DEADEND_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(LINE_PTS)} />
    </g>
  );

  return (
    <Plate
      label="Double dead-end with line conductor"
      aspect={1}
      fit={[...DEADEND_BOXES, ...DEADEND_WIRES]}
      theme="system"
      className="iso-figure iso-deadend"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={10} cy={10} r={7} />}
        front={<path className="ik-detail" d="M5 8V124 M13 8V124" />}
      />
      <ScatterBox at={at} rest={ARM_TOP} index={1} count={N} r={3}
        front={<path className="ik-detail" d="M4 4H126" />}
      />
      <ScatterBox at={at} rest={ARM_BOT} index={2} count={N} r={3}
        front={<path className="ik-detail" d="M4 4H126" />}
      />
      <ScatterBox at={at} rest={BOLT} index={3} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M4 0V56" />
            <circle className="ik-detail" cx={4} cy={6} r={2.5} />
            <circle className="ik-detail" cx={4} cy={50} r={2.5} />
          </>
        }
      />
      <Press
        label="Flash the dead-end eye"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={EYE} index={4} count={N}
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
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
