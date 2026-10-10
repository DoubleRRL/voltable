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

const POLE: Box3 = { x: 60, y: 120, z: 0, w: 20, d: 20, h: 170 };
const COND_A: Box3 = { x: 64, y: 136, z: 0, w: 8, d: 6, h: 34 };
const COND_B: Box3 = { x: 76, y: 136, z: 0, w: 8, d: 6, h: 26 };
const GUARD: Box3 = { x: 60, y: 134, z: 30, w: 30, d: 8, h: 70 };
const STRAP_LO: Box3 = { x: 58, y: 133, z: 44, w: 34, d: 10, h: 4 };
const STRAP_HI: Box3 = { x: 58, y: 133, z: 78, w: 34, d: 10, h: 4 };

// Sweeps bending from each conduit top back into the pole face.
const SWEEP_A_PTS: Vec3[] = curve(
  [68, 139, 34],
  [68, 139, 52],
  [68, 138, 66],
  [70, 130, 72],
);
const SWEEP_B_PTS: Vec3[] = curve(
  [80, 139, 26],
  [80, 139, 42],
  [80, 138, 54],
  [74, 130, 60],
);
const SWEEP_A_PATH = makePath(SWEEP_A_PTS);
const SWEEP_B_PATH = makePath(SWEEP_B_PTS);

const RISER_BOXES = [POLE, COND_A, COND_B, GUARD, STRAP_LO, STRAP_HI];
const RISER_POINTS: Vec3[] = [...SWEEP_A_PTS, ...SWEEP_B_PTS];
const RISER_FIELD = field(RISER_BOXES, RISER_POINTS);

/**
 * Riser and U-guard: a pole base with two conduits climbing its face into a
 * cover strip strapped on with two bands, sweeps bending from the conduit
 * tops back into the pole. Pressing flashes a strap bolt; the flash is the
 * whole output.
 */
export function RiserFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 6;
  const at = transition ? parts(RISER_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <>
      <path className="ik-line" d={SWEEP_A_PATH} />
      <path className="ik-line" d={SWEEP_B_PATH} />
    </>
  );

  return (
    <Plate
      label="Riser and U-guard"
      aspect={1}
      fit={[...RISER_BOXES, ...RISER_POINTS]}
      theme="system"
      className="iso-figure iso-riser"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={4}
        front={<path className="ik-detail" d="M6 6V164 M14 6V164" />}
      />
      <ScatterBox at={at} rest={COND_A} index={1} count={N} r={2} />
      <ScatterBox at={at} rest={COND_B} index={2} count={N} r={2} />
      <ScatterBox at={at} rest={GUARD} index={3} count={N}
        r={2}
        front={
          <path className="ik-detail" d="M4 8V62 M26 8V62" />
        }
      />
      <ScatterBox at={at} rest={STRAP_LO} index={4} count={N} r={1} />
      <Press
        label="Flash the strap bolt"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={STRAP_HI} index={5} count={N}
            r={1}
            front={
              <circle
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                cx={17}
                cy={2}
                r={1.6}
              />
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
