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

const GRADE: Box3 = { x: 0, y: 60, z: 0, w: 190, d: 90, h: 6 };
const POST_A: Box3 = { x: 44, y: 108, z: 6, w: 12, d: 12, h: 150 };
const POST_B: Box3 = { x: 118, y: 108, z: 6, w: 12, d: 12, h: 150 };
const BOARD: Box3 = { x: 30, y: 102, z: 62, w: 114, d: 8, h: 78 };
const SOCKET: Box3 = { x: 38, y: 96, z: 92, w: 26, d: 14, h: 34 };
const PANEL: Box3 = { x: 72, y: 96, z: 84, w: 62, d: 14, h: 50 };

// Service drop lands from overhead onto the socket top; ground wire runs
// from the panel bottom down into the grade.
const DROP_PTS: Vec3[] = curve(
  [20, 130, 200],
  [34, 122, 170],
  [46, 112, 140],
  [51, 103, 127],
);
const GROUND_PTS: Vec3[] = curve(
  [100, 102, 84],
  [100, 100, 50],
  [100, 98, 20],
  [100, 96, 7],
);
const DROP_PATH = makePath(DROP_PTS);
const GROUND_PATH = makePath(GROUND_PTS);

const METER_BOXES = [GRADE, POST_A, POST_B, BOARD, SOCKET, PANEL];
const METER_POINTS: Vec3[] = [...DROP_PTS, ...GROUND_PTS];
const METER_FIELD = field(METER_BOXES, METER_POINTS);

/**
 * Meter panel and service: a weatherproof meter board hung on two posts with
 * buried bases, a round-socket meter and a breaker panel cabinet mounted on
 * the board, the overhead drop landing on the socket and a ground wire
 * running down into the grade. Pressing flashes the meter glass; the flash
 * is the whole output.
 */
export function MeterPanelFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 6;
  const at = transition ? parts(METER_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <>
      <path className="ik-line" d={DROP_PATH} />
      <path className="ik-line" d={GROUND_PATH} />
    </>
  );

  return (
    <Plate
      label="Meter panel and service"
      aspect={1}
      fit={[...METER_BOXES, ...METER_POINTS]}
      theme="system"
      className="iso-figure iso-meterpanel"
    >
      <ScatterBox at={at} rest={GRADE} index={0} count={N}
        r={2}
        top={
          <path className="ik-detail" d="M20 20l10 -10 M50 20l10 -10 M80 20l10 -10 M110 20l10 -10 M140 20l10 -10 M170 20l10 -10" />
        }
      />
      <ScatterBox at={at} rest={POST_A} index={1} count={N}
        r={3}
        front={<path className="ik-detail" d="M4 6V148 M8 6V148" />}
      />
      <ScatterBox at={at} rest={POST_B} index={2} count={N}
        r={3}
        front={<path className="ik-detail" d="M4 6V148 M8 6V148" />}
      />
      <ScatterBox at={at} rest={BOARD} index={3} count={N}
        r={2}
        front={
          <path className="ik-detail" d="M6 8V70 M108 8V70" />
        }
      />
      <Press
        label="Flash the meter"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={SOCKET} index={4} count={N}
            r={6}
            front={
              <>
                <circle className="ik-detail" cx={13} cy={17} r={11} />
                <circle
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  cx={13}
                  cy={17}
                  r={2.5}
                />
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={PANEL} index={5} count={N}
        r={4}
        front={
          <>
            <path className="ik-detail" d="M31 8V42" />
            <rect
              className="ik-detail"
              x={36}
              y={18}
              width={6}
              height={16}
              rx={2}
            />
            <path className="ik-detail" d="M39 22V30" />
          </>
        }
      />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
