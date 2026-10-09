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

// Three wood poles in a row, left to right on screen. x + y is constant so
// the bases sit level while x - y spreads them horizontally: the left pole
// is nearest, the right pole farthest.
const LEFT_POLE: Box3 = { x: 50, y: 170, z: 0, w: 16, d: 16, h: 168 };
const MID_POLE: Box3 = { x: 110, y: 110, z: 0, w: 16, d: 16, h: 168 };
const RIGHT_POLE: Box3 = { x: 170, y: 50, z: 0, w: 16, d: 16, h: 168 };

const CROSS_L: Box3 = { x: 20, y: 172, z: 138, w: 76, d: 12, h: 10 };
const CROSS_M: Box3 = { x: 80, y: 112, z: 138, w: 76, d: 12, h: 10 };
const CROSS_R: Box3 = { x: 140, y: 52, z: 138, w: 76, d: 12, h: 10 };

// Three crossarm insulators per pole; tops sit 6 below the pole tops.
const INS_L0: Box3 = { x: 30, y: 172, z: 148, w: 12, d: 12, h: 14 };
const INS_L1: Box3 = { x: 52, y: 172, z: 148, w: 12, d: 12, h: 14 };
const INS_L2: Box3 = { x: 74, y: 172, z: 148, w: 12, d: 12, h: 14 };
const INS_M0: Box3 = { x: 90, y: 112, z: 148, w: 12, d: 12, h: 14 };
const INS_M1: Box3 = { x: 112, y: 112, z: 148, w: 12, d: 12, h: 14 };
const INS_M2: Box3 = { x: 134, y: 112, z: 148, w: 12, d: 12, h: 14 };
const INS_R0: Box3 = { x: 150, y: 52, z: 148, w: 12, d: 12, h: 14 };
const INS_R1: Box3 = { x: 172, y: 52, z: 148, w: 12, d: 12, h: 14 };
const INS_R2: Box3 = { x: 194, y: 52, z: 148, w: 12, d: 12, h: 14 };

// Pole-mount transformer hung off the left pole's +x face: two hanger
// brackets bridge the visible gap between pole face (x 66) and can face
// (x 72); the can body carries cooling fins, a wider lid rim caps it, and
// two bushings stand on the lid.
const HANG_BOT: Box3 = { x: 66, y: 174, z: 76, w: 6, d: 8, h: 4 };
const HANG_TOP: Box3 = { x: 66, y: 174, z: 102, w: 6, d: 8, h: 4 };
const CAN: Box3 = { x: 72, y: 167, z: 68, w: 28, d: 22, h: 46 };
const LID: Box3 = { x: 70, y: 165, z: 114, w: 32, d: 26, h: 7 };
const BUSH_A: Box3 = { x: 77, y: 174, z: 121, w: 8, d: 8, h: 12 };
const BUSH_B: Box3 = { x: 89, y: 174, z: 121, w: 8, d: 8, h: 12 };

const GRAIN = "M5 6V162 M11 6V162";
const FINS = "M7 6V40 M14 6V40 M21 6V40";
const FINS_SIDE = "M7 6V40 M15 6V40";

/** One sagging span between two insulator tops. */
function spanPts(a: Vec3, b: Vec3, drop: number): Vec3[] {
  const p1: Vec3 = [
    a[0] + (b[0] - a[0]) * 0.33,
    a[1] + (b[1] - a[1]) * 0.33,
    a[2] + (b[2] - a[2]) * 0.33 - drop,
  ];
  const p2: Vec3 = [
    a[0] + (b[0] - a[0]) * 0.66,
    a[1] + (b[1] - a[1]) * 0.66,
    a[2] + (b[2] - a[2]) * 0.66 - drop,
  ];
  return curve(a, p1, p2, b);
}

// Primary: three parallel wires, one per insulator rank, sagging between
// each pair of poles.
const L0T: Vec3 = [36, 178, 162];
const M0T: Vec3 = [96, 118, 162];
const R0T: Vec3 = [156, 58, 162];
const L1T: Vec3 = [58, 178, 162];
const M1T: Vec3 = [118, 118, 162];
const R1T: Vec3 = [178, 58, 162];
const L2T: Vec3 = [80, 178, 162];
const M2T: Vec3 = [140, 118, 162];
const R2T: Vec3 = [200, 58, 162];

const WIRE0_PTS: Vec3[] = [
  ...spanPts(L0T, M0T, 12),
  ...spanPts(M0T, R0T, 12).slice(1),
];
const WIRE1_PTS: Vec3[] = [
  ...spanPts(L1T, M1T, 12),
  ...spanPts(M1T, R1T, 12).slice(1),
];
const WIRE2_PTS: Vec3[] = [
  ...spanPts(L2T, M2T, 12),
  ...spanPts(M2T, R2T, 12).slice(1),
];
const WIRE0_PATH = makePath(WIRE0_PTS);
const WIRE1_PATH = makePath(WIRE1_PTS);
const WIRE2_PATH = makePath(WIRE2_PTS);

// Triplex secondary: twisted pair hanging below the crossarms from the
// middle pole's east face to the right pole's west face.
const SEC_START: Vec3 = [126, 118, 120];
const SEC_END: Vec3 = [170, 58, 120];
const SEC_MID1: Vec3 = [140.5, 98.2, 106];
const SEC_MID2: Vec3 = [155.5, 77.8, 106];
const SEC_BASE = curve(SEC_START, SEC_MID1, SEC_MID2, SEC_END, 48);

const SEC_DX = SEC_END[0] - SEC_START[0];
const SEC_DY = SEC_END[1] - SEC_START[1];
const SEC_LEN = Math.hypot(SEC_DX, SEC_DY);
const SEC_PX = -SEC_DY / SEC_LEN;
const SEC_PY = SEC_DX / SEC_LEN;

function twist(base: Vec3[], flip: 1 | -1): Vec3[] {
  return base.map((p, i) => {
    const t = i / (base.length - 1);
    const phase = t * Math.PI * 8;
    const point: Vec3 = [
      p[0] + SEC_PX * Math.sin(phase) * 2.6 * flip,
      p[1] + SEC_PY * Math.sin(phase) * 2.6 * flip,
      p[2] + Math.cos(phase) * 1.4 * flip,
    ];
    return point;
  });
}

const SEC_A_PTS = twist(SEC_BASE, 1);
const SEC_B_PTS = twist(SEC_BASE, -1);
const SEC_A_PATH = makePath(SEC_A_PTS);
const SEC_B_PATH = makePath(SEC_B_PTS);

// Short jumpers from the two eastern primary wires down to the bushing tops
// (bushing centres x 81 / 93, y 178, tops z 133).
const J1_PTS = curve(
  [58, 178, 160],
  [60, 178, 150],
  [70, 178, 138],
  [81, 178, 134],
);
const J2_PTS = curve(
  [80, 178, 160],
  [82, 178, 151],
  [87, 178, 139],
  [93, 178, 134],
);
const J1_PATH = makePath(J1_PTS);
const J2_PATH = makePath(J2_PTS);

/**
 * Travel field, built once from the rest pose. The wire curves are included
 * because the spans reach well past the boxes at both ends, and a field that
 * ignored them would pull the whole figure toward the wrong centre.
 */
const POLE_BOXES = [
  LEFT_POLE, MID_POLE, RIGHT_POLE,
  CROSS_L, CROSS_M, CROSS_R,
  INS_L0, INS_L1, INS_L2, INS_M0, INS_M1, INS_M2, INS_R0, INS_R1, INS_R2,
  HANG_BOT, HANG_TOP, CAN, LID, BUSH_A, BUSH_B,
];

const POLE_POINTS: Vec3[] = [
  ...WIRE0_PTS, ...WIRE1_PTS, ...WIRE2_PTS, ...SEC_A_PTS, ...SEC_B_PTS, ...J1_PTS, ...J2_PTS,
];

const POLE_FIELD = field(POLE_BOXES, POLE_POINTS);

/**
 * Three-pole distribution line: three crossarm poles carrying a 3-conductor
 * primary, a pole-mount transformer can on hanger brackets off the left
 * pole (wide lid rim, two lid bushings with jumpers), and a twisted triplex
 * secondary between the middle and right poles. Pressing flashes the
 * transformer bushing; the flash is the whole output.
 */
export function PoleFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 21;
  const at = transition ? parts(POLE_FIELD, transition) : null;
  // Wires are unstaggered, so they fade off the raw progress rather than a
  // part's sub-window — they have no separate motion to be legible through.
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <>
      <path className="ik-line" d={WIRE0_PATH} />
      <path className="ik-line" d={WIRE1_PATH} />
      <path className="ik-line" d={WIRE2_PATH} />
      <path className="ik-line" d={SEC_A_PATH} />
      <path className="ik-line" d={SEC_B_PATH} />
      <path className="ik-line" d={J1_PATH} />
      <path className="ik-line" d={J2_PATH} />
    </>
  );

  return (
    <Plate
      label="Distribution pole"
      aspect={1}
      fit={[...POLE_BOXES, ...POLE_POINTS]}
      theme="system"
      className="iso-figure"
    >
      {/* Back pole first, front pole last. Boxes numbered 0..20 in paint order. */}
      <ScatterBox at={at} rest={RIGHT_POLE} index={0} count={N}
        r={4}
        front={<path className="ik-detail" d={GRAIN} />}
      />
      <ScatterBox at={at} rest={CROSS_R} index={1} count={N}
        r={4}
        front={
          <>
            <circle className="ik-fill" cx={35} cy={5} r={1.4} />
            <circle className="ik-fill" cx={41} cy={5} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={INS_R0} index={2} count={N} r={3} />
      <ScatterBox at={at} rest={INS_R1} index={3} count={N} r={3} />
      <ScatterBox at={at} rest={INS_R2} index={4} count={N} r={3} />
      <ScatterBox at={at} rest={MID_POLE} index={5} count={N}
        r={4}
        front={<path className="ik-detail" d={GRAIN} />}
      />
      <ScatterBox at={at} rest={CROSS_M} index={6} count={N}
        r={4}
        front={
          <>
            <circle className="ik-fill" cx={35} cy={5} r={1.4} />
            <circle className="ik-fill" cx={41} cy={5} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={INS_M0} index={7} count={N} r={3} />
      <ScatterBox at={at} rest={INS_M1} index={8} count={N} r={3} />
      <ScatterBox at={at} rest={INS_M2} index={9} count={N} r={3} />
      <ScatterBox at={at} rest={LEFT_POLE} index={10} count={N}
        r={4}
        front={<path className="ik-detail" d={GRAIN} />}
      />
      <ScatterBox at={at} rest={CROSS_L} index={11} count={N}
        r={4}
        front={
          <>
            <circle className="ik-fill" cx={35} cy={5} r={1.4} />
            <circle className="ik-fill" cx={41} cy={5} r={1.4} />
          </>
        }
      />
      <ScatterBox at={at} rest={INS_L0} index={12} count={N} r={3} />
      <ScatterBox at={at} rest={INS_L1} index={13} count={N} r={3} />
      <ScatterBox at={at} rest={INS_L2} index={14} count={N} r={3} />
      <Press
        label="Flash the transformer"
        sound={false}
        onPress={() => setPulses((n) => n + 1)}
        disabled={transition !== undefined}
      >
        <g>
          <ScatterBox at={at} rest={HANG_BOT} index={15} count={N} r={1} />
          <ScatterBox at={at} rest={HANG_TOP} index={16} count={N} r={1} />
          <ScatterBox at={at} rest={CAN} index={17} count={N}
            r={8}
            front={<path className="ik-detail" d={FINS} />}
            side={<path className="ik-detail" d={FINS_SIDE} />}
          />
          <ScatterBox at={at} rest={LID} index={18} count={N} r={2} />
          <ScatterBox at={at} rest={BUSH_A} index={19} count={N} r={2} />
          <ScatterBox at={at} rest={BUSH_B} index={20} count={N}
            r={2}
            top={
              <circle
                key={pulses}
                className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                cx={4}
                cy={4}
                r={2.4}
              />
            }
          />
        </g>
      </Press>
      {transition ? <g opacity={wireVeil}>{wires}</g> : wires}
    </Plate>
  );
}
