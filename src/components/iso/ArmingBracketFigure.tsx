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
 * Double-arming brackets, after ADS 10 Fig 10–18 Diagram A (p125–126).
 *
 * The diagram shows the pole saddled between two arms on bracket castings:
 * each casting straddles the pole face with bolt circles top and bottom,
 * and spacer rods tie the arm ends. The castings are the subject — the arms
 * alone would read as the crossarm figure, so the bolts they carry are drawn
 * large and the focal bolt is the press target. No wires: Diagram A carries
 * none, and anchor guys (not conductors) take the load per the sheet notes.
 */
const POLE: Box3 = { x: 66, y: 90, z: 20, w: 18, d: 18, h: 130 };

const ARM_TOP: Box3 = { x: 8, y: 90, z: 120, w: 130, d: 12, h: 8 };
const ARM_BOT: Box3 = { x: 8, y: 90, z: 80, w: 130, d: 12, h: 8 };

/** Bracket castings straddling the pole between the arms. */
const BRK_L: Box3 = { x: 52, y: 88, z: 86, w: 14, d: 18, h: 38 };
const BRK_R: Box3 = { x: 84, y: 88, z: 86, w: 14, d: 18, h: 38 };

/** Spacer rods tying the arm ends. */
const ROD_L: Box3 = { x: 12, y: 90, z: 80, w: 6, d: 8, h: 48 };
const ROD_R: Box3 = { x: 132, y: 90, z: 80, w: 6, d: 8, h: 48 };

const BRACKET_BOXES = [POLE, ARM_TOP, ARM_BOT, BRK_L, BRK_R, ROD_L, ROD_R];
const BRACKET_FIELD = field(BRACKET_BOXES, []);

/**
 * Double-arming brackets.
 *
 * ADS 10 Fig 10–18 Diagram A: the pole rides between the arms on castings,
 * the castings bolted top and bottom. Pressing flashes a bracket bolt; the
 * flash is the whole output.
 */
export function ArmingBracketFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 7;
  const at = transition ? parts(BRACKET_FIELD, transition) : null;

  const boltPair = (hot: boolean) => (
    <>
      <circle
        key={hot ? pulses : "cold-top"}
        className={hot && pulses === 0 ? "ik-live" : hot ? "ik-live glow-target" : "ik-detail"}
        cx={7}
        cy={8}
        r={3}
      />
      <circle className="ik-detail" cx={7} cy={30} r={3} />
    </>
  );

  return (
    <Plate
      label="Double-arming brackets"
      aspect={1}
      fit={BRACKET_BOXES}
      theme="system"
      className="iso-figure iso-bracket"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={10} cy={10} r={7} />}
        front={<path className="ik-detail" d="M5 8V124 M13 8V124" />}
      />
      <ScatterBox at={at} rest={ARM_TOP} index={1} count={N} r={3}
        front={<path className="ik-detail" d="M4 4H126" />}
      />
      <ScatterBox at={at} rest={ARM_BOT} index={2} count={N} r={3}
        front={<path className="ik-detail" d="M4 4H126" />}
      />
      <ScatterBox at={at} rest={BRK_L} index={3} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M1 2H13 M1 36H13" />
            {boltPair(false)}
          </>
        }
      />
      <Press
        label="Flash a bracket bolt"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={BRK_R} index={4} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d="M1 2H13 M1 36H13" />
                {boltPair(true)}
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={ROD_L} index={5} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M3 0V48" />
            <circle className="ik-detail" cx={3} cy={5} r={2.5} />
            <circle className="ik-detail" cx={3} cy={43} r={2.5} />
          </>
        }
      />
      <ScatterBox at={at} rest={ROD_R} index={6} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M3 0V48" />
            <circle className="ik-detail" cx={3} cy={5} r={2.5} />
            <circle className="ik-detail" cx={3} cy={43} r={2.5} />
          </>
        }
      />
    </Plate>
  );
}
