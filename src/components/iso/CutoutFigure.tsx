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
 * Branch fusing on a covered-conductor arm, after DOH CC 131-1.
 *
 * The two devices hang off the arm on standoff brackets, 18" minimum from the
 * pole centreline, and they are not the same object: the fuse holder is a
 * hinged link between two insulator stacks, and the arrester is a single
 * ribbed column. Drawing them as one similar box is what made the earlier
 * figure unreadable.
 */
const POLE: Box3 = { x: 118, y: 92, z: 0, w: 18, d: 18, h: 146 };
const ARM: Box3 = { x: 22, y: 90, z: 112, w: 112, d: 14, h: 10 };

/** Line-side insulator of the fuse holder. */
const CUT_TOP: Box3 = { x: 30, y: 92, z: 118, w: 14, d: 14, h: 26 };

/** Fuse holder body: the link swings inside this, hinged at the top. */
const HOLDER: Box3 = { x: 30, y: 92, z: 88, w: 14, d: 14, h: 30 };

/** Load-side insulator of the fuse holder. */
const CUT_BOT: Box3 = { x: 30, y: 92, z: 58, w: 14, d: 14, h: 30 };

/** Surge arrester: one ribbed column, not a stack of two. */
const ARRESTER: Box3 = { x: 72, y: 92, z: 52, w: 16, d: 16, h: 62 };

/** Standoff brackets carrying each device off the arm. */
const BRACKET_CUT: Box3 = { x: 28, y: 90, z: 112, w: 18, d: 12, h: 8 };
const BRACKET_ARR: Box3 = { x: 70, y: 90, z: 112, w: 20, d: 12, h: 8 };

/**
 * The bypass jumper: line side down through the holder to the load side, with
 * the arc-follower loop bridging the two so the fuse can be worked hot. CC 131
 * Note 6 puts line on the top of the holder and load on the bottom, which is
 * what makes the loop read as a bridge rather than a second run.
 */
const JUMPER_PTS: Vec3[] = curve(
  [34, 96, 146],
  [8, 104, 128],
  [4, 106, 74],
  [34, 96, 30],
);
const JUMPER_PATH = makePath(JUMPER_PTS);

const CUT_BOXES = [POLE, ARM, BRACKET_CUT, CUT_TOP, HOLDER, CUT_BOT, BRACKET_ARR, ARRESTER];
const CUT_FIELD = field(CUT_BOXES, JUMPER_PTS);

/** Sheds on an insulator: horizontal ribs, tighter toward the top. */
const SHEDS = (count: number, width: number) =>
  Array.from({ length: count }, (_, i) => `M0 ${3 + i * 4}H${width}`).join(" ");

/**
 * Fuse cutout and surge arrester on a covered-conductor arm.
 *
 * CC 131-1: the fuse holder on the load side, line into the top of the holder
 * and load out of the bottom, with the jumper looping the two; the arrester
 * beside it on its own bracket. Note 6 is the reason the holder is drawn with
 * its line end up. Pressing flashes the holder's latch; the flash is the whole
 * output.
 */
export function CutoutFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 8;
  const at = transition ? parts(CUT_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      {/* Line in at the top of the holder, load out at the bottom: CC 131
          Note 6. The jumper is the C that bridges the two, which is what lets
          the fuse be worked without dropping the branch. */}
      <path className="ik-line" d="M0 96H37" />
      <path className="ik-line" d="M37 96V30" />
      <path className="ik-line" d="M37 30H96" />
      <path className="ik-line" d={JUMPER_PATH} />
    </g>
  );

  return (
    <Plate
      label="Fuse cutout and surge arrester"
      aspect={1}
      fit={[...CUT_BOXES, ...JUMPER_PTS]}
      theme="system"
      className="iso-figure iso-cutout"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={10} cy={10} r={7} />}
        front={
          <>
            <path className="ik-detail" d="M5 8V140 M13 8V140" />
            {/* HIGH VOLTAGE sign, which CC 131-1 shows between the devices. */}
            <rect className="ik-detail" x={2} y={82} width={14} height={10} rx={1} />
          </>
        }
      />
      <ScatterBox at={at} rest={ARM} index={1} count={N} r={3}
        top={<path className="ik-detail" d="M6 6H128" />}
      />
      <ScatterBox at={at} rest={BRACKET_CUT} index={2} count={N} r={2}
        front={<path className="ik-detail" d="M1 4H17" />}
      />
      {/* Line-side insulator: sheds tapering up toward the line. */}
      <ScatterBox at={at} rest={CUT_TOP} index={3} count={N} r={3}
        front={
          <>
            <path className="ik-detail" d={SHEDS(5, 14)} />
            <path className="ik-detail" d="M7 -3V0 M7 26V30" />
          </>
        }
      />
      <ScatterBox at={at} rest={BRACKET_ARR} index={4} count={N} r={2}
        front={<path className="ik-detail" d="M1 4H19" />}
      />
      {/* Arrester: a single ribbed column, sheds of even length. */}
      <ScatterBox at={at} rest={ARRESTER} index={5} count={N} r={3}
        front={
          <>
            <path className="ik-detail" d={SHEDS(13, 16)} />
            {/* Studs top and bottom, as the CC 131-1 inset shows. */}
            <path className="ik-detail" d="M8 -4V0 M8 62V66" />
          </>
        }
      />
      <ScatterBox at={at} rest={CUT_BOT} index={6} count={N} r={3}
        front={
          <>
            <path className="ik-detail" d={SHEDS(6, 14)} />
            <path className="ik-detail" d="M7 0V3 M7 30V34" />
          </>
        }
      />
      <Press
        label="Flash the fuse holder latch"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          {/* Holder body carries the fuse link and the latch that opens it. */}
          <ScatterBox at={at} rest={HOLDER} index={7} count={N}
            r={3}
            front={
              <>
                {/* The link itself, hinged at the top insulator. */}
                <path className="ik-detail" d="M7 2L7 34" />
                <path className="ik-detail" d="M2 2H12 M2 34H12" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={11}
                  y={15}
                  width={3}
                  height={7}
                  rx={1.5}
                />
              </>
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
