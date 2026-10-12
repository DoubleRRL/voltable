"use client";

import { useState } from "react";

import {
  Plate,
  Press,
  type Box3,
} from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

/**
 * Through-bored pole at the groundline, after PLM Fig 14 (p163).
 *
 * The transverse view shows the below-grade shell drilled with ½" holes for
 * preservative, the groundline marked where the pole meets earth. The holes
 * stop at the groundline — wood above grade is not bored — which is the one
 * detail that makes the drawing read as through-boring rather than damage.
 */
const POLE: Box3 = { x: 60, y: 90, z: 30, w: 26, d: 26, h: 120 };

/** Earth band crossing the pole at the groundline. */
const GRADE: Box3 = { x: 35, y: 86, z: 52, w: 76, d: 26, h: 10 };

/** Pole tag nailed above grade. */
const TAG: Box3 = { x: 66, y: 88, z: 110, w: 14, d: 6, h: 10 };

const BORE_BOXES = [POLE, GRADE, TAG];
const BORE_FIELD = field(BORE_BOXES, []);

/** ½" bore holes: dot grid on the below-grade shell only (face y 4–20). */
const HOLES = Array.from({ length: 4 }, (_, r) =>
  Array.from({ length: 4 }, (_, c) => `M${4 + c * 6} ${5 + r * 4}h1.2`).join(" ")
).join(" ");

/** Earth hatching on the grade band. */
const HATCH =
  Array.from({ length: 8 }, (_, i) => `M${5 + i * 8} 10L${9 + i * 8} 0`).join(" ");

/**
 * Through-bored pole.
 *
 * PLM Fig 14: bored shell below the groundline, clean wood above, tag
 * nailed high. Pressing flashes the tag nail; the flash is the whole output.
 */
export function BoredPoleFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 3;
  const at = transition ? parts(BORE_FIELD, transition) : null;

  return (
    <Plate
      label="Through-bored pole"
      aspect={1}
      fit={BORE_BOXES}
      theme="system"
      className="iso-figure iso-boredpole"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={8}
        top={<circle className="ik-detail" cx={14} cy={14} r={8} />}
        front={
          <>
            {/* Grain above grade; the bore holes below it. */}
            <path className="ik-detail" d="M6 30V116 M13 30V116 M20 30V116" />
            <path className="ik-detail" d={HOLES} />
            {/* Groundline mark where boring stops. */}
            <path className="ik-detail" d="M0 24H26" />
          </>
        }
      />
      <ScatterBox at={at} rest={GRADE} index={1} count={N} r={2}
        front={<path className="ik-detail" d={HATCH} />}
      />
      <Press
        label="Flash the pole tag"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={TAG} index={2} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d="M1 1H13 M1 9H13" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={6}
                  y={3}
                  width={3}
                  height={4}
                  rx={1.5}
                />
              </>
            }
          />
        </g>
      </Press>
    </Plate>
  );
}
