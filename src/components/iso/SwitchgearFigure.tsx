"use client";

import { useState } from "react";
import { Plate, Press, type Box3 } from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

const PLINTH: Box3 = { x: 0, y: 0, z: 0, w: 150, d: 70, h: 10 };
const SEC1: Box3 = { x: 6, y: 6, z: 10, w: 43, d: 58, h: 118 };
const SEC2: Box3 = { x: 53, y: 6, z: 10, w: 43, d: 58, h: 118 };
const SEC3: Box3 = { x: 100, y: 6, z: 10, w: 43, d: 58, h: 118 };
const HANDLE: Box3 = { x: 70, y: 64, z: 58, w: 10, d: 8, h: 26 };

const VENTS = "M7 92H36 M7 98H36 M7 104H36";

const SW_FIELD = field([PLINTH, SEC1, SEC2, SEC3, HANDLE]);

/**
 * Switchgear lineup: three tall sections on a plinth, each with a breaker
 * handle and vents; the left section carries a small amps screen. Pressing
 * flashes the middle section's protruding handle; the flash is the output.
 */
export function SwitchgearFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);
  const at = transition ? parts(SW_FIELD, transition) : null;

  return (
    <Plate
      label="Switchgear lineup"
      aspect={1}
      fit={[PLINTH, SEC1, SEC2, SEC3, HANDLE]}
      theme="system"
      className="iso-figure iso-switchgear"
    >
      <ScatterBox at={at} rest={PLINTH} index={0} count={5} r={4} />
      <ScatterBox at={at} rest={SEC1} index={1} count={5} r={5}
        front={
          <>
            <rect
              className="ik-screen"
              x={7}
              y={10}
              width={29}
              height={18}
              rx={2}
            />
            <text className="ik-screen-text" x={10} y={23} fontSize={8}>
              1200A
            </text>
            <rect
              className="ik-detail"
              x={15}
              y={48}
              width={13}
              height={26}
              rx={2}
            />
            <path className="ik-detail" d="M21 52V70" />
            <path className="ik-detail" d={VENTS} />
          </>
        }
      />
      <ScatterBox at={at} rest={SEC2} index={2} count={5} r={5}
        front={
          <>
            <rect
              className="ik-well"
              x={14}
              y={44}
              width={15}
              height={30}
              rx={2}
            />
            <path className="ik-detail" d={VENTS} />
          </>
        }
      />
      <ScatterBox at={at} rest={SEC3} index={3} count={5} r={5}
        front={
          <>
            <rect
              className="ik-detail"
              x={15}
              y={48}
              width={13}
              height={26}
              rx={2}
            />
            <path className="ik-detail" d="M21 52V70" />
            <path className="ik-detail" d={VENTS} />
          </>
        }
      />
      <Press
        label="Flash the switchgear breaker handle"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={HANDLE} index={4} count={5} r={2}
            front={
              <rect
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                x={2}
                y={7}
                width={6}
                height={12}
                rx={2}
              />
            }
          />
        </g>
      </Press>
    </Plate>
  );
}
