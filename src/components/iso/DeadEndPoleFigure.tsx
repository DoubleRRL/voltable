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

// Dead-end pole: the span arrives, terminates, and the unbalanced pull goes
// somewhere — down the full-tension guy lead to an anchor. PLM Figure 5
// (Reduced Tension Guyed Span Example, PLM 2-48) draws exactly this: pole,
// crossarm, conductors dead-ending at the insulators, guy lead leaving the
// pole top for the anchor.
const SOIL: Box3 = { x: 0, y: 108, z: -10, w: 250, d: 62, h: 10 };
const POLE: Box3 = { x: 70, y: 118, z: 0, w: 18, d: 18, h: 185 };
const CROSS: Box3 = { x: 38, y: 120, z: 150, w: 82, d: 14, h: 12 };
const INS0: Box3 = { x: 48, y: 120, z: 162, w: 12, d: 12, h: 14 };
const INS1: Box3 = { x: 70, y: 120, z: 162, w: 12, d: 12, h: 14 };
const INS2: Box3 = { x: 92, y: 120, z: 162, w: 12, d: 12, h: 14 };
// Anchor rod below the grade line in open air, eye where the guy turns onto
// it — the same underground-anchor language as the guy figure.
const ROD: Box3 = { x: 188, y: 46, z: -54, w: 8, d: 8, h: 44 };
const EYE: Box3 = { x: 185, y: 43, z: -14, w: 14, d: 14, h: 9 };

const GRAIN = "M5 6V179 M11 6V179";

/** Dead-end spans: they arrive and terminate, so they sag slightly and stop. */
function spanPts(a: Vec3, b: Vec3, drop: number): Vec3[] {
  const p1: Vec3 = [
    a[0] + (b[0] - a[0]) * 0.33,
    a[1] + (b[1] - a[1]) * 0.33,
    a[2] + (b[2] - a[2]) * 0.33 - drop,
  ];
  const p2: Vec3 = [
    a[0] + (b[0] - a[0]) * 0.66,
    a[1] + (b[1] - a[1]) * 0.66,
    a[2] + (b[2] - a[2]) * 0.66 - drop,
  ];
  return curve(a, p1, p2, b);
}

// Insulator tops sit at z 176; spans arrive from off-frame right and stop.
const SPAN0_PTS = spanPts([212, 52, 168], [98, 114, 176], 7);
const SPAN1_PTS = spanPts([212, 62, 166], [76, 114, 176], 7);
const SPAN0_PATH = makePath(SPAN0_PTS);
const SPAN1_PATH = makePath(SPAN1_PTS);

// Full-tension guy lead: taut, pole top to anchor eye.
const GUY_PTS: Vec3[] = curve(
  [79, 127, 172],
  [118, 102, 118],
  [156, 76, 52],
  [192, 50, -6],
);
const GUY_PATH = makePath(GUY_PTS);

const DEADEND_BOXES = [SOIL, POLE, CROSS, INS0, INS1, INS2, ROD, EYE];
const DEADEND_POINTS: Vec3[] = [...SPAN0_PTS, ...SPAN1_PTS, ...GUY_PTS];
const DEADEND_FIELD = field(DEADEND_BOXES, DEADEND_POINTS);

/**
 * Dead-end guy pole: crossarm pole where two spans terminate at the
 * insulators, and the unbalanced pull leaves down a full-tension guy lead to
 * an anchor whose rod hangs below the grade line. Drawn from PLM Figure 5
 * (Reduced Tension Guyed Span Example, PLM 2-48). Pressing flashes the middle
 * dead-end insulator where the spans land; the flash is the whole output.
 */
export function DeadEndPoleFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 8;
  const at = transition ? parts(DEADEND_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <>
      <path className="ik-line" d={SPAN0_PATH} />
      <path className="ik-line" d={SPAN1_PATH} />
      <path className="ik-line" d={GUY_PATH} />
    </>
  );

  return (
    <Plate
      label="Dead-end guy pole"
      aspect={1}
      fit={[...DEADEND_BOXES, ...DEADEND_POINTS]}
      theme="system"
      className="iso-figure"
    >
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
        r={4}
        front={<path className="ik-detail" d={GRAIN} />}
      />
      <ScatterBox at={at} rest={CROSS} index={2} count={N}
        r={4}
        front={
          <>
            <circle className="ik-fill" cx={35} cy={5} r={1.4} />
            <circle className="ik-fill" cx={41} cy={5} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={INS0} index={3} count={N} r={3} />
      <ScatterBox at={at} rest={INS1} index={4} count={N} r={3} />
      <ScatterBox at={at} rest={ROD} index={6} count={N} r={2} />
      <ScatterBox at={at} rest={EYE} index={7} count={N}
        r={2}
        front={
          <circle
            className="ik-detail"
            cx={7}
            cy={4.5}
            r={3.2}
          />
        }
      />
      <Press
        label="Flash the dead-end insulator"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={INS2} index={5} count={N}
            r={3}
            top={
              <circle
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                cx={6}
                cy={6}
                r={2.4}
              />
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
