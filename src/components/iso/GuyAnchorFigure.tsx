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

const GROUND: Box3 = { x: 0, y: 0, z: 0, w: 210, d: 120, h: 8 };
const POLE: Box3 = { x: 40, y: 140, z: 8, w: 16, d: 16, h: 160 };
const ROD: Box3 = { x: 150, y: 60, z: 8, w: 6, d: 6, h: 40 };
const GUARD: Box3 = { x: 147, y: 57, z: 8, w: 12, d: 12, h: 30 };

// Taut guy: pole top straight to the anchor rod eye, nearly no sag.
const GUY_PTS: Vec3[] = curve(
  [48, 148, 166],
  [90, 118, 128],
  [130, 84, 82],
  [153, 63, 50],
);
const GUY_PATH = makePath(GUY_PTS);

const GUY_BOXES = [GROUND, POLE, ROD, GUARD];
const GUY_FIELD = field(GUY_BOXES, GUY_PTS);

/**
 * Guy wire and anchor: a pole stub carrying a taut guy down to an anchor rod
 * eye, the rod sleeved in a yellow guard where it leaves the ground. The wire
 * is a drawn curve because the kit's boxes are axis-aligned and a guy is
 * diagonal by definition. Pressing flashes the guard band; the flash is the
 * whole output.
 */
export function GuyAnchorFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 4;
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
      <ScatterBox at={at} rest={GROUND} index={0} count={N}
        r={2}
        top={
          <path className="ik-detail" d="M20 20h170 M20 100h170" />
        }
      />
      <ScatterBox at={at} rest={POLE} index={1} count={N}
        r={4}
        front={<path className="ik-detail" d="M5 6V152 M11 6V152" />}
      />
      <ScatterBox at={at} rest={ROD} index={2} count={N}
        r={2}
        front={
          <circle className="ik-detail" cx={3} cy={4} r={2} />
        }
      />
      <Press
        label="Flash the guy guard"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={GUARD} index={3} count={N}
            r={2}
            front={
              <rect
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                x={3}
                y={20}
                width={6}
                height={4}
                rx={1}
              />
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
