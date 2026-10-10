"use client";

import { useState } from "react";

import { Plate, Press, type Box3 } from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

const PLINTH: Box3 = { x: 0, y: 0, z: 0, w: 156, d: 64, h: 12 };
const SEC1: Box3 = { x: 6, y: 6, z: 12, w: 46, d: 54, h: 118 };
const SEC2: Box3 = { x: 54, y: 6, z: 12, w: 46, d: 54, h: 118 };
const SEC3: Box3 = { x: 102, y: 6, z: 12, w: 46, d: 54, h: 118 };
const ROOF: Box3 = { x: 2, y: 4, z: 130, w: 152, d: 58, h: 12 };
const HANDLE: Box3 = { x: 73, y: 60, z: 58, w: 10, d: 8, h: 30 };

const VENTS = "M7 96H39 M7 102H39 M7 108H39";
const VENTS_LOW = "M7 8H39 M7 14H39 M7 20H39";

const SW_FIELD = field([PLINTH, SEC1, SEC2, SEC3, ROOF, HANDLE]);

/**
 * Indoor 1200A metal-clad lineup: three shallow equipment sections sharing
 * one plinth under a common bus-duct roof, each section fronted by double
 * doors with paired handles and louver bands top and bottom, an instrument
 * window and the amps screen on the left section, and breaker position lamps
 * on the middle one. Pressing flashes the main breaker operating handle; the
 * flash is the whole output.
 */
export function SwitchgearFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);
  const at = transition ? parts(SW_FIELD, transition) : null;

  return (
    <Plate
      label="1200 amp switchgear"
      aspect={1}
      fit={[PLINTH, SEC1, SEC2, SEC3, ROOF, HANDLE]}
      theme="system"
      className="iso-figure iso-switchgear"
    >
      <ScatterBox at={at} rest={PLINTH} index={0} count={6}
        r={3}
        front={
          <>
            <path className="ik-detail" d="M4 4H152" />
            <circle className="ik-fill" cx={14} cy={6} r={1.4} />
            <circle className="ik-fill" cx={52} cy={6} r={1.4} />
            <circle className="ik-fill" cx={90} cy={6} r={1.4} />
            <circle className="ik-fill" cx={128} cy={6} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={SEC1} index={1} count={6}
        r={5}
        front={
          <>
            <rect
              className="ik-screen"
              x={8}
              y={8}
              width={30}
              height={18}
              rx={2}
            />
            <text className="ik-screen-text" x={11} y={21} fontSize={8}>
              1200A
            </text>
            <path className="ik-detail" d="M23 30V112" />
            <rect
              className="ik-detail"
              x={13}
              y={52}
              width={7}
              height={22}
              rx={2}
            />
            <rect
              className="ik-detail"
              x={26}
              y={52}
              width={7}
              height={22}
              rx={2}
            />
            <path className="ik-detail" d="M16.5 56V70 M29.5 56V70" />
            <path className="ik-detail" d={VENTS} />
            <path className="ik-detail" d={VENTS_LOW} />
          </>
        }
      />
      <ScatterBox at={at} rest={SEC2} index={2} count={6}
        r={5}
        front={
          <>
            <circle className="ik-fill" cx={12} cy={14} r={2.2} />
            <circle className="ik-fill" cx={21} cy={14} r={2.2} />
            <path className="ik-detail" d="M23 26V112" />
            <rect
              className="ik-detail"
              x={13}
              y={52}
              width={7}
              height={22}
              rx={2}
            />
            <rect
              className="ik-detail"
              x={26}
              y={52}
              width={7}
              height={22}
              rx={2}
            />
            <path className="ik-detail" d="M16.5 56V70 M29.5 56V70" />
            <path className="ik-detail" d={VENTS} />
            <path className="ik-detail" d={VENTS_LOW} />
          </>
        }
      />
      <ScatterBox at={at} rest={SEC3} index={3} count={6}
        r={5}
        front={
          <>
            <path className="ik-detail" d="M23 30V112" />
            <rect
              className="ik-detail"
              x={13}
              y={52}
              width={7}
              height={22}
              rx={2}
            />
            <rect
              className="ik-detail"
              x={26}
              y={52}
              width={7}
              height={22}
              rx={2}
            />
            <path className="ik-detail" d="M16.5 56V70 M29.5 56V70" />
            <path className="ik-detail" d={VENTS} />
            <path className="ik-detail" d={VENTS_LOW} />
          </>
        }
      />
      <ScatterBox at={at} rest={ROOF} index={4} count={6}
        r={3}
        front={
          <>
            <path className="ik-detail" d="M4 6H148" />
            <rect
              className="ik-detail"
              x={64}
              y={3}
              width={24}
              height={6}
              rx={1}
            />
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
          <ScatterBox at={at} rest={HANDLE} index={5} count={6}
            r={2}
            front={
              <rect
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                x={2}
                y={9}
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
