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
 * Pole-top transformer can, after DOH AC 410–1 (p69).
 *
 * The sheet hangs the can off the pole on a hanger bracket: cylindrical tank
 * with a lid, two high-voltage bushings on top, and a ground lead run down
 * the pole face. Drawn as the can alone — no cable, no potheads, no bank —
 * because the can with its bushings is the object a planner pictures, and
 * the sheet draws it plainly enough to copy: lid rim, band, twin bushings.
 */
const POLE: Box3 = { x: 118, y: 92, z: 0, w: 18, d: 18, h: 150 };

/** Hanger bracket carrying the can off the pole. */
const HANGER: Box3 = { x: 100, y: 90, z: 92, w: 20, d: 14, h: 10 };

/** Tank: cylindrical body with lid rim and band. */
const CAN: Box3 = { x: 56, y: 90, z: 40, w: 44, d: 28, h: 54 };

/** High-voltage bushings on the lid. */
const BUSH_1: Box3 = { x: 62, y: 93, z: 94, w: 8, d: 8, h: 12 };
const BUSH_2: Box3 = { x: 84, y: 93, z: 94, w: 8, d: 8, h: 12 };

/** Ground lead from the can down to grade, kept just off the tank face so
 * it reads instead of hiding inside the can's depth. */
const GROUND_PTS: Vec3[] = [
  [58, 92, 44],
  [56, 92, 30],
  [55, 92, 15],
  [54, 92, 2],
];

const XFMR_BOXES = [POLE, HANGER, CAN, BUSH_1, BUSH_2];
const XFMR_WIRES = [...GROUND_PTS];
const XFMR_FIELD = field(XFMR_BOXES, XFMR_WIRES);

/**
 * Pole-top transformer can.
 *
 * DOH AC 410–1: tank on a hanger, twin bushings up, ground lead down.
 * Pressing flashes a bushing; the flash is the whole output.
 */
export function TransformerFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 5;
  const at = transition ? parts(XFMR_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(GROUND_PTS)} />
    </g>
  );

  return (
    <Plate
      label="Pole-top transformer"
      aspect={1}
      fit={[...XFMR_BOXES, ...GROUND_PTS]}
      theme="system"
      className="iso-figure iso-transformer"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={10} cy={10} r={7} />}
        front={<path className="ik-detail" d="M5 8V144 M13 8V144" />}
      />
      <ScatterBox at={at} rest={HANGER} index={1} count={N} r={2}
        front={<path className="ik-detail" d="M1 5H19 M10 0V10" />}
      />
      <ScatterBox at={at} rest={CAN} index={2} count={N} r={4}
        top={
          <>
            {/* Lid rim. */}
            <rect className="ik-detail" x={2} y={10} width={40} height={8} rx={4} />
          </>
        }
        front={
          <>
            {/* Tank band and shell seams. */}
            <path className="ik-detail" d="M0 10H44 M0 44H44" />
            <path className="ik-detail" d="M11 10V54 M22 10V54 M33 10V54" />
          </>
        }
      />
      <Press
        label="Flash a transformer bushing"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={BUSH_1} index={3} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d="M0 3H8 M0 9H8" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={2}
                  y={0}
                  width={4}
                  height={5}
                  rx={2}
                />
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={BUSH_2} index={4} count={N} r={2}
        front={<path className="ik-detail" d="M0 3H8 M0 9H8 M4 0V12" />}
      />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
