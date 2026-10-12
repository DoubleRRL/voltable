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

/**
 * Double crossarm dead-end assembly, after ADS 10 Fig 10–19 (p128).
 *
 * The drawing shows two 8-foot arms with the pole saddled between them on
 * through-bolts, and spacer rods tying the arm ends together — the rods end
 * in eyes that take the dead-end wire. The two arms are the same object
 * twice, not an arm plus a brace: both carry the saddle plates at the pole
 * and both are tied by the same end rods. Everything structural shares one
 * depth; the saddles pass through the pole rather than butting it.
 */
const POLE: Box3 = { x: 66, y: 90, z: 20, w: 18, d: 18, h: 130 };

const ARM_TOP: Box3 = { x: 8, y: 90, z: 120, w: 130, d: 12, h: 8 };
const ARM_BOT: Box3 = { x: 8, y: 90, z: 80, w: 130, d: 12, h: 8 };

/** Saddle plates bolting each arm through the pole. */
const SADDLE_TOP: Box3 = { x: 62, y: 88, z: 118, w: 26, d: 20, h: 12 };
const SADDLE_BOT: Box3 = { x: 62, y: 88, z: 78, w: 26, d: 20, h: 12 };

/** Spacer rods tying the arm ends, eyes top and bottom. */
const ROD_L: Box3 = { x: 12, y: 90, z: 80, w: 6, d: 8, h: 48 };
const ROD_R: Box3 = { x: 132, y: 90, z: 80, w: 6, d: 8, h: 48 };

/** Dead-end jumpers looping off each rod eye. */
const JUMP_LT: Vec3[] = curve([15, 90, 128], [8, 90, 134], [3, 90, 140], [0, 90, 146]);
const JUMP_LB: Vec3[] = curve([15, 90, 80], [8, 90, 74], [3, 90, 68], [0, 90, 62]);
const JUMP_RT: Vec3[] = curve([135, 90, 128], [142, 90, 134], [147, 90, 140], [150, 90, 146]);
const JUMP_RB: Vec3[] = curve([135, 90, 80], [142, 90, 74], [147, 90, 68], [150, 90, 62]);

const ARM_BOXES = [POLE, ARM_TOP, ARM_BOT, SADDLE_TOP, SADDLE_BOT, ROD_L, ROD_R];
const ARM_WIRES = [...JUMP_LT, ...JUMP_LB, ...JUMP_RT, ...JUMP_RB];
const ARM_FIELD = field(ARM_BOXES, ARM_WIRES);

/**
 * Double crossarm dead-end assembly.
 *
 * ADS 10 Fig 10–19: dead-end wires land on the rod eyes at the arm ends,
 * the pole saddled between the arms. Pressing flashes a dead-end eye; the
 * flash is the whole output.
 */
export function CrossarmFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 7;
  const at = transition ? parts(ARM_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(JUMP_LT)} />
      <path className="ik-line" d={makePath(JUMP_LB)} />
      <path className="ik-line" d={makePath(JUMP_RT)} />
      <path className="ik-line" d={makePath(JUMP_RB)} />
    </g>
  );

  return (
    <Plate
      label="Double crossarm dead-end"
      aspect={1}
      fit={[...ARM_BOXES, ...ARM_WIRES]}
      theme="system"
      className="iso-figure iso-crossarm"
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
      <ScatterBox at={at} rest={SADDLE_TOP} index={3} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M1 6H25" />
            <circle className="ik-detail" cx={6} cy={6} r={2} />
            <circle className="ik-detail" cx={20} cy={6} r={2} />
          </>
        }
      />
      <ScatterBox at={at} rest={SADDLE_BOT} index={4} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M1 6H25" />
            <circle className="ik-detail" cx={6} cy={6} r={2} />
            <circle className="ik-detail" cx={20} cy={6} r={2} />
          </>
        }
      />
      <ScatterBox at={at} rest={ROD_L} index={5} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M3 0V48" />
            <circle className="ik-detail" cx={3} cy={5} r={2.5} />
            <circle className="ik-detail" cx={3} cy={43} r={2.5} />
          </>
        }
      />
      <Press
        label="Flash a dead-end eye"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={ROD_R} index={6} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d="M3 0V48" />
                <circle
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  cx={3}
                  cy={5}
                  r={2.5}
                />
                <circle className="ik-detail" cx={3} cy={43} r={2.5} />
              </>
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
