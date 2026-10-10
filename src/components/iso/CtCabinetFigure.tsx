"use client";

import { useState } from "react";

import { Plate, Press, type Box3 } from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

const CABINET: Box3 = { x: 20, y: 20, z: 0, w: 90, d: 70, h: 110 };
const BOARD: Box3 = { x: 116, y: 24, z: 0, w: 44, d: 14, h: 120 };
const SOCKET: Box3 = { x: 124, y: 22, z: 60, w: 28, d: 20, h: 40 };

const CT_FIELD = field([CABINET, BOARD, SOCKET]);

/**
 * CT cabinet and meter socket: a floor-standing CT cabinet with a hinged
 * door, latch and vents beside a backboard carrying a round-socket meter.
 * Pressing flashes the meter glass; the flash is the whole output.
 */
export function CtCabinetFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);
  const at = transition ? parts(CT_FIELD, transition) : null;

  return (
    <Plate
      label="CT cabinet and meter"
      aspect={1}
      fit={[CABINET, BOARD, SOCKET]}
      theme="system"
      className="iso-figure iso-ctcabinet"
    >
      <ScatterBox at={at} rest={CABINET} index={0} count={3}
        r={5}
        front={
          <>
            <path className="ik-detail" d="M70 8V102" />
            <rect
              className="ik-detail"
              x={76}
              y={46}
              width={6}
              height={18}
              rx={2}
            />
            <path className="ik-detail" d="M79 50V60" />
            <path className="ik-detail" d="M12 92H58 M12 98H58" />
          </>
        }
      />
      <ScatterBox at={at} rest={BOARD} index={1} count={3}
        r={2}
        front={
          <>
            <circle className="ik-fill" cx={8} cy={10} r={1.4} />
            <circle className="ik-fill" cx={36} cy={10} r={1.4} />
            <circle className="ik-fill" cx={8} cy={110} r={1.4} />
            <circle className="ik-fill" cx={36} cy={110} r={1.4} />
          </>
        }
      />
      <Press
        label="Flash the meter"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={SOCKET} index={2} count={3}
            r={6}
            front={
              <>
                <circle className="ik-detail" cx={14} cy={20} r={11} />
                <circle
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  cx={14}
                  cy={20}
                  r={2.5}
                />
              </>
            }
          />
        </g>
      </Press>
    </Plate>
  );
}
