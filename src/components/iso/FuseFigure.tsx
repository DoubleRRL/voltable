"use client";

import { useState } from "react";

import {
  Plate,
  Press,
  path as makePath,
  type Box3,
  type Vec3,
} from "react-isokit";

import { field, parts, veil, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

/**
 * 15 kV open fuse cutout, after ADS 10 Fig 10–11 (p59, top-left catalog item).
 *
 * The catalog drawing shows a ribbed insulator column with the fuse tube
 * hung alongside it between top and bottom terminals: line into the top
 * contact, load out of the bottom, the tube near-vertical with a slight
 * tilt the iso boxes draw straight. The mounting bracket carries the whole
 * assembly off the pole. What distinguishes it from a switch is the tube
 * itself — a separate link between two contacts, not a blade inside a body.
 */
const POLE: Box3 = { x: 118, y: 92, z: 0, w: 18, d: 18, h: 150 };

/** Bracket carrying the cutout off the pole face. */
const MOUNT: Box3 = { x: 100, y: 90, z: 96, w: 22, d: 14, h: 8 };

/** Insulator column: ribbed, line end up. */
const INSULATOR: Box3 = { x: 56, y: 92, z: 62, w: 14, d: 14, h: 72 };

/** Fuse tube hung between the terminals. */
const TUBE: Box3 = { x: 74, y: 92, z: 66, w: 10, d: 10, h: 64 };

/** Top terminal arm: insulator top to tube top. */
const TERM_TOP: Box3 = { x: 52, y: 92, z: 130, w: 34, d: 12, h: 6 };

/** Bottom terminal arm: tube bottom to insulator bottom. */
const TERM_BOT: Box3 = { x: 52, y: 92, z: 60, w: 34, d: 12, h: 6 };

/** Line in at the top contact's height. */
const LINE_PTS: Vec3[] = [
  [0, 92, 133],
  [18, 92, 133],
  [35, 92, 133],
  [52, 92, 133],
];
/** Load out at the bottom contact's height. */
const LOAD_PTS: Vec3[] = [
  [52, 92, 63],
  [35, 92, 63],
  [18, 92, 63],
  [0, 92, 63],
];

const FUSE_BOXES = [POLE, MOUNT, INSULATOR, TUBE, TERM_TOP, TERM_BOT];
const FUSE_WIRES = [...LINE_PTS, ...LOAD_PTS];
const FUSE_FIELD = field(FUSE_BOXES, FUSE_WIRES);

/** Sheds on the insulator column. */
const SHEDS =
  Array.from({ length: 14 }, (_, i) => `M0 ${4 + i * 4.5}H14`).join(" ");

/**
 * 15 kV open fuse cutout.
 *
 * ADS 10 Fig 10–11: line into the top contact, load out of the bottom, the
 * tube replaceable between the two. Pressing flashes the top latch; the
 * flash is the whole output.
 */
export function FuseFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 6;
  const at = transition ? parts(FUSE_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(LINE_PTS)} />
      <path className="ik-line" d={makePath(LOAD_PTS)} />
    </g>
  );

  return (
    <Plate
      label="15 kV open fuse cutout"
      aspect={1}
      fit={[...FUSE_BOXES, ...FUSE_WIRES]}
      theme="system"
      className="iso-figure iso-fuse"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={10} cy={10} r={7} />}
        front={<path className="ik-detail" d="M5 8V144 M13 8V144" />}
      />
      <ScatterBox at={at} rest={MOUNT} index={1} count={N} r={2}
        front={<path className="ik-detail" d="M1 4H21 M11 0V8" />}
      />
      <ScatterBox at={at} rest={INSULATOR} index={2} count={N} r={3}
        front={
          <>
            <path className="ik-detail" d={SHEDS} />
            <path className="ik-detail" d="M7 -4V0 M7 72V76" />
          </>
        }
      />
      <Press
        label="Flash the fuse tube latch"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          {/* The tube with its top latch — the part a crew pulls. */}
          <ScatterBox at={at} rest={TUBE} index={3} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d="M5 0V64" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={6}
                  y={2}
                  width={3}
                  height={8}
                  rx={1.5}
                />
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={TERM_TOP} index={4} count={N} r={2}
        front={<path className="ik-detail" d="M1 3H33 M7 0V6 M27 0V6" />}
      />
      <ScatterBox at={at} rest={TERM_BOT} index={5} count={N} r={2}
        front={<path className="ik-detail" d="M1 3H33 M7 0V6 M27 0V6" />}
      />
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
