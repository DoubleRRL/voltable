"use client";

import { useState } from "react";
import { Plate, Press, type Box3 } from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

const PAD: Box3 = { x: 0, y: 0, z: 0, w: 150, d: 110, h: 12 };
const CABINET: Box3 = { x: 18, y: 18, z: 12, w: 114, d: 74, h: 68 };

const PAD_FIELD = field([PAD, CABINET]);

/**
 * Padmount transformer: cabinet on a concrete pad, double doors drawn as
 * seams with a warning decal on the right door. Pressing flashes the left
 * door handle; the flash is the whole output.
 */
export function PadmountFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);
  // Press is inert mid-transition so focus can never strand on a moving part.
  const at = transition ? parts(PAD_FIELD, transition) : null;

  return (
    <Plate
      label="Padmount transformer"
      aspect={1}
      fit={[PAD, CABINET]}
      theme="system"
      className="iso-figure iso-padmount"
    >
      <ScatterBox at={at} rest={PAD} index={0} count={2} r={6} />
      <Press
        label="Flash the padmount door handle"
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
            top={<path className="ik-detail" d="M57 0V74" />}
            front={
              <>
                <rect
                  className="ik-detail"
                  x={8}
                  y={6}
                  width={98}
                  height={56}
                  rx={2}
                />
                <path className="ik-detail" d="M57 6V62" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={48}
                  y={28}
                  width={5}
                  height={15}
                  rx={2.5}
                />
                <rect
                  className="ik-detail"
                  x={61}
                  y={28}
                  width={5}
                  height={15}
                  rx={2.5}
                />
                <rect
                  className="ik-detail"
                  x={78}
                  y={14}
                  width={20}
                  height={24}
                  rx={2}
                />
                <path
                  className="ik-detail"
                  d="M89 17l-5 9h4l-2 7 6-10h-4l3-6z"
                />
              </>
            }
          />
        </g>
      </Press>
    </Plate>
  );
}
