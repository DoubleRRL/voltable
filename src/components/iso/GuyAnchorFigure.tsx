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

const GRADE: Box3 = { x: 0, y: 0, z: 0, w: 230, d: 130, h: 6 };
const POLE: Box3 = { x: 40, y: 140, z: 6, w: 16, d: 16, h: 170 };
const ROD: Box3 = { x: 150, y: 60, z: 6, w: 6, d: 6, h: 44 };
const EYE: Box3 = { x: 149, y: 59, z: 50, w: 8, d: 8, h: 5 };
const GUARD: Box3 = { x: 147, y: 57, z: 6, w: 12, d: 12, h: 30 };

// Taut guy: pole bolt straight to the anchor eye, nearly no sag —
// a guy is tensioned hardware, not a span.
const GUY_PTS: Vec3[] = curve(
  [48, 148, 168],
  [90, 118, 132],
  [130, 84, 86],
  [153, 63, 55],
);
const GUY_PATH = makePath(GUY_PTS);

const GUY_BOXES = [GRADE, POLE, ROD, EYE, GUARD];
const GUY_FIELD = field(GUY_BOXES, GUY_PTS);

/**
 * Guy wire and anchor: a round wood pole (grain, cap ring) carrying a taut
 * guy from a through-bolt down to the eye of an anchor rod, the rod sleeved
 * in a guard where it leaves the grade. The wire is a drawn curve because
 * the kit's boxes are axis-aligned and a guy is diagonal by definition.
 * Pressing flashes the guard band; the flash is the whole output.
 */
export function GuyAnchorFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 5;
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
      <ScatterBox at={at} rest={GRADE} index={0} count={N}
        r={2}
        top={
          <path className="ik-detail" d="M20 20l10 -10 M50 20l10 -10 M80 20l10 -10 M110 20l10 -10 M140 20l10 -10 M170 20l10 -10 M200 20l10 -10" />
        }
      />
      <ScatterBox at={at} rest={POLE} index={1} count={N}
        r={7}
        top={
          <circle className="ik-detail" cx={8} cy={8} r={5.5} />
        }
        front={
          <>
            <path className="ik-detail" d="M5 6V164 M11 6V164" />
            <circle className="ik-fill" cx={8} cy={152} r={1.6} />
          </>
        }
      />
      <ScatterBox at={at} rest={ROD} index={2} count={N} r={2} />
      <ScatterBox at={at} rest={EYE} index={3} count={N} r={2} />
      <Press
        label="Flash the guy guard"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={GUARD} index={4} count={N}
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
