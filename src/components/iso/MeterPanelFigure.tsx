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

const WALL: Box3 = { x: 10, y: 130, z: 0, w: 120, d: 10, h: 150 };
const PANEL: Box3 = { x: 40, y: 118, z: 40, w: 56, d: 16, h: 80 };
const MAST: Box3 = { x: 104, y: 124, z: 60, w: 8, d: 8, h: 100 };
const HEAD: Box3 = { x: 102, y: 122, z: 160, w: 12, d: 12, h: 8 };

// Drip loop: service drop lands on the weatherhead, loops down, and rises
// into the panel top (panel top z 120, mast +x face).
const DRIP_PTS: Vec3[] = curve(
  [108, 128, 190],
  [112, 128, 168],
  [100, 126, 150],
  [76, 124, 121],
);
const DRIP_PATH = makePath(DRIP_PTS);

const METER_BOXES = [WALL, PANEL, MAST, HEAD];
const METER_FIELD = field(METER_BOXES, DRIP_PTS);

/**
 * Meter panel and service mast: a wall stub carrying a meter panel cabinet
 * with a round socket, breaker door and handle, a riser mast climbing past
 * it to a weatherhead, and a drip loop sagging between the two. Pressing
 * flashes the meter glass; the flash is the whole output.
 */
export function MeterPanelFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 4;
  const at = transition ? parts(METER_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = <path className="ik-line" d={DRIP_PATH} />;

  return (
    <Plate
      label="Meter panel and mast"
      aspect={1}
      fit={[...METER_BOXES, ...DRIP_PTS]}
      theme="system"
      className="iso-figure iso-meterpanel"
    >
      <ScatterBox at={at} rest={WALL} index={0} count={N}
        r={2}
        front={
          <path className="ik-detail" d="M4 20H116 M4 130H116" />
        }
      />
      <Press
        label="Flash the meter"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={PANEL} index={1} count={N}
            r={4}
            front={
              <>
                <circle className="ik-detail" cx={20} cy={26} r={11} />
                <circle
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  cx={20}
                  cy={26}
                  r={2.5}
                />
                <path className="ik-detail" d="M38 10V70" />
                <rect
                  className="ik-detail"
                  x={43}
                  y={30}
                  width={6}
                  height={18}
                  rx={2}
                />
                <path className="ik-detail" d="M46 34V44" />
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={MAST} index={2} count={N}
        r={2}
        front={
          <>
            <circle className="ik-fill" cx={4} cy={30} r={1.4} />
            <circle className="ik-fill" cx={4} cy={70} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={HEAD} index={3} count={N} r={3} />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
