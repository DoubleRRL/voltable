"use client";

import { useState } from "react";

import { Plate, Press, type Box3 } from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

const PAD: Box3 = { x: 0, y: 0, z: 0, w: 170, d: 100, h: 12 };
const CABINET: Box3 = { x: 14, y: 14, z: 12, w: 142, d: 72, h: 76 };

const JUNCTION_FIELD = field([PAD, CABINET]);

/**
 * Junction cabinet: a wide PMH-style cabinet on a concrete pad, three door
 * seams with a latch on each and the warning decal on the middle door.
 * Pressing flashes the middle door latch; the flash is the whole output.
 */
export function JunctionCabinetFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);
  const at = transition ? parts(JUNCTION_FIELD, transition) : null;

  return (
    <Plate
      label="Junction cabinet"
      aspect={1}
      fit={[PAD, CABINET]}
      theme="system"
      className="iso-figure iso-junction"
    >
      <ScatterBox at={at} rest={PAD} index={0} count={2} r={6} />
      <Press
        label="Flash the junction door latch"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox
            at={at}
            rest={CABINET}
            index={1}
            count={2}
            r={8}
            top={<path className="ik-detail" d="M47 0V72 M95 0V72" />}
            front={
              <>
                <rect
                  className="ik-detail"
                  x={8}
                  y={6}
                  width={126}
                  height={64}
                  rx={2}
                />
                <path className="ik-detail" d="M47 6V70 M95 6V70" />
                <rect
                  className="ik-detail"
                  x={21}
                  y={30}
                  width={5}
                  height={15}
                  rx={2.5}
                />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={68}
                  y={30}
                  width={5}
                  height={15}
                  rx={2.5}
                />
                <rect
                  className="ik-detail"
                  x={116}
                  y={30}
                  width={5}
                  height={15}
                  rx={2.5}
                />
                <rect
                  className="ik-detail"
                  x={61}
                  y={12}
                  width={20}
                  height={14}
                  rx={2}
                />
                <path
                  className="ik-detail"
                  d="M72 14l-4 6h3l-1.5 5 4.5-7h-3l2-4z"
                />
              </>
            }
          />
        </g>
      </Press>
    </Plate>
  );
}
