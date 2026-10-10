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

const POLE: Box3 = { x: 80, y: 100, z: 0, w: 18, d: 18, h: 180 };
const ARM: Box3 = { x: 40, y: 102, z: 130, w: 110, d: 12, h: 10 };
const BRACKET: Box3 = { x: 90, y: 98, z: 140, w: 26, d: 20, h: 8 };
const CAN: Box3 = { x: 86, y: 94, z: 148, w: 34, d: 28, h: 44 };
const BUSH_1: Box3 = { x: 92, y: 102, z: 192, w: 6, d: 6, h: 10 };
const BUSH_2: Box3 = { x: 103, y: 102, z: 192, w: 6, d: 6, h: 10 };
const BUSH_3: Box3 = { x: 114, y: 94, z: 192, w: 6, d: 6, h: 10 };
const CTRL: Box3 = { x: 58, y: 104, z: 60, w: 34, d: 22, h: 48 };

// Jumpers from the outer bushings down toward the arm line, and the control
// cable dropping from the can to the control cabinet.
const J1_PTS: Vec3[] = curve(
  [95, 105, 202],
  [80, 104, 190],
  [66, 103, 172],
  [58, 103, 158],
);
const J2_PTS: Vec3[] = curve(
  [117, 99, 202],
  [130, 100, 190],
  [140, 101, 172],
  [145, 102, 158],
);
const CABLE_PTS: Vec3[] = curve(
  [100, 100, 148],
  [96, 102, 128],
  [92, 104, 112],
  [80, 108, 108],
);
const J1_PATH = makePath(J1_PTS);
const J2_PATH = makePath(J2_PTS);
const CABLE_PATH = makePath(CABLE_PTS);

const RECLOSER_BOXES = [POLE, ARM, BRACKET, CAN, BUSH_1, BUSH_2, BUSH_3, CTRL];
const RECLOSER_POINTS: Vec3[] = [...J1_PTS, ...J2_PTS, ...CABLE_PTS];
const RECLOSER_FIELD = field(RECLOSER_BOXES, RECLOSER_POINTS);

/**
 * Recloser: a pole section with a crossarm, a round can on a bracket above
 * the arm carrying three lid bushings with jumpers, and a control cabinet
 * hung on the pole below with a cable dropping to it from the can. Pressing
 * flashes the control handle; the flash is the whole output.
 */
export function RecloserFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 8;
  const at = transition ? parts(RECLOSER_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <>
      <path className="ik-line" d={J1_PATH} />
      <path className="ik-line" d={J2_PATH} />
      <path className="ik-line" d={CABLE_PATH} />
    </>
  );

  return (
    <Plate
      label="Recloser"
      aspect={1}
      fit={[...RECLOSER_BOXES, ...RECLOSER_POINTS]}
      theme="system"
      className="iso-figure iso-recloser"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={4}
        front={<path className="ik-detail" d="M6 6V174 M12 6V174" />}
      />
      <ScatterBox at={at} rest={ARM} index={1} count={N}
        r={4}
        front={
          <>
            <circle className="ik-fill" cx={20} cy={5} r={1.4} />
            <circle className="ik-fill" cx={90} cy={5} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={BRACKET} index={2} count={N} r={2} />
      <ScatterBox at={at} rest={CAN} index={3} count={N}
        r={10}
        front={<path className="ik-detail" d="M8 8V36 M17 8V36 M26 8V36" />}
        side={<path className="ik-detail" d="M8 8V36 M20 8V36" />}
      />
      <ScatterBox at={at} rest={BUSH_1} index={4} count={N} r={2} />
      <ScatterBox at={at} rest={BUSH_2} index={5} count={N} r={2} />
      <ScatterBox at={at} rest={BUSH_3} index={6} count={N} r={2} />
      <Press
        label="Flash the recloser control"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={CTRL} index={7} count={N}
            r={4}
            front={
              <>
                <path className="ik-detail" d="M26 8V40" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={28}
                  y={20}
                  width={4}
                  height={10}
                  rx={2}
                />
              </>
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
