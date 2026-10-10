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

const ARM: Box3 = { x: 40, y: 100, z: 120, w: 120, d: 12, h: 10 };
const INS_A: Box3 = { x: 56, y: 100, z: 130, w: 12, d: 12, h: 14 };
const INS_B: Box3 = { x: 132, y: 100, z: 130, w: 12, d: 12, h: 14 };
const TUBE: Box3 = { x: 80, y: 100, z: 80, w: 10, d: 10, h: 40 };
const ARRESTER: Box3 = { x: 120, y: 100, z: 84, w: 14, d: 14, h: 36 };

// Jumper from the fuse tube top over to the arrester top.
const JUMPER_PTS: Vec3[] = curve(
  [85, 105, 120],
  [95, 105, 128],
  [115, 105, 128],
  [127, 105, 120],
);
const JUMPER_PATH = makePath(JUMPER_PTS);

const CUTOUT_BOXES = [ARM, INS_A, INS_B, TUBE, ARRESTER];
const CUTOUT_FIELD = field(CUTOUT_BOXES, JUMPER_PTS);

/**
 * Cutout and arrester: a crossarm carrying two insulators, a near-vertical
 * fuse tube between them, and a skirted arrester cylinder, with a jumper
 * arcing from tube top to arrester top. (The kit's boxes are axis-aligned, so
 * the tube stands vertical the way some cutouts mount, and the jumper is a
 * drawn curve.) Pressing flashes the tube's top contact; the flash is the
 * whole output.
 */
export function CutoutFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 5;
  const at = transition ? parts(CUTOUT_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = <path className="ik-line" d={JUMPER_PATH} />;

  return (
    <Plate
      label="Cutout and arrester"
      aspect={1}
      fit={[...CUTOUT_BOXES, ...JUMPER_PTS]}
      theme="system"
      className="iso-figure iso-cutout"
    >
      <ScatterBox at={at} rest={ARM} index={0} count={N}
        r={4}
        front={
          <>
            <circle className="ik-fill" cx={20} cy={5} r={1.4} />
            <circle className="ik-fill" cx={100} cy={5} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={INS_A} index={1} count={N} r={3} />
      <ScatterBox at={at} rest={INS_B} index={2} count={N} r={3} />
      <Press
        label="Flash the fuse contact"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={TUBE} index={3} count={N}
            r={4}
            front={
              <>
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={3}
                  y={2}
                  width={4}
                  height={5}
                  rx={1}
                />
                <rect
                  className="ik-detail"
                  x={3}
                  y={31}
                  width={4}
                  height={5}
                  rx={1}
                />
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={ARRESTER} index={4} count={N}
        r={7}
        front={
          <path className="ik-detail" d="M2 8H12 M2 16H12 M2 24H12" />
        }
      />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
