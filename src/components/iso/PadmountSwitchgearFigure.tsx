"use client";

import { useState } from "react";

import { Plate, Press, type Box3 } from "react-isokit";

import { field, parts, type Transition } from "./scatter";
import { ScatterBox } from "./ScatterBox";

/**
 * Proportions from UGS SS 540-1: a 6'-0" x 4'-0" concrete pad 6" thick with a
 * 4'-0" x 2'-6" opening set 1'-0" from the load-side edge. The cabinet stands in
 * that opening, so the pad reads as a frame around it rather than a plinth.
 */
const PAD: Box3 = { x: 0, y: 0, z: 0, w: 168, d: 112, h: 16 };

/**
 * The PME cabinet from UGS SS 587-1: near-cube in elevation, not a wide low
 * box, with two doors on the front face and the compartment divisions behind
 * them. Its depth is the pad opening, 2'-6".
 */
const CABINET: Box3 = { x: 28, y: 21, z: 16, w: 112, d: 70, h: 104 };

/** Three-piece hinged roof, slightly proud of the cabinet and hinged at the back. */
const ROOF: Box3 = { x: 25, y: 18, z: 120, w: 118, d: 76, h: 7 };

/** One 600 A switch bushing; a fuse compartment carries a 200 A well. */
const BUSHING: Box3 = { x: 58, y: 48, z: 127, w: 16, d: 16, h: 13 };

/** Right-hand door handle — the Press target, as on the accepted padmount. */
const HANDLE: Box3 = { x: 90, y: 14, z: 62, w: 5, d: 7, h: 20 };

const PME_BOXES = [PAD, CABINET, ROOF, BUSHING, HANDLE];
const PME_FIELD = field(PME_BOXES);

/**
 * Padmount switchgear (PME) on its pad.
 *
 * Drawn from UGS rather than from memory, which is why it does not look like the
 * earlier three-door cabinet: SS 587-1 shows a near-cube steel cabinet with two
 * doors and the compartment divisions behind them, and SS 540-1/540-2.1 show the
 * 6'-0" x 4'-0" pad with its 4'-0" x 2'-6" opening. A PME-3, PME-4 or PME-5.
 *
 * The roof carries round bushings because the elbows land there: 600 A bushings
 * over a switch compartment, 200 A wells over a fuse compartment. Pressing
 * flashes the door handle; the flash is the whole output.
 */
export function PadmountSwitchgearFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);
  // Press is inert mid-transition so focus can never strand on a moving part.
  const at = transition ? parts(PME_FIELD, transition) : null;

  return (
    <Plate
      label="PME pad-mount switchgear"
      aspect={1}
      fit={PME_BOXES}
      theme="system"
      className="iso-figure iso-pme"
    >
      {/* Pad: a frame around the opening, which is what SS 540-2.1 draws. */}
      <ScatterBox at={at} rest={PAD} index={0} count={5} r={5}
        top={
          <>
            <path className="ik-detail" d="M28 21H140V91H28Z" />
            <path className="ik-detail" d="M28 21L140 91M140 21L28 91" />
          </>
        }
        front={
          <>
            <path className="ik-detail" d="M28 5V11 M140 5V11" />
            <path className="ik-detail" d="M28 8H140" />
          </>
        }
      />
      <ScatterBox at={at} rest={CABINET} index={1} count={5} r={9}
        top={<path className="ik-detail" d="M56 0V70 M84 0V70" />}
        front={
          <>
            {/* Two doors, as SS 587-1 shows — not three. */}
            <rect className="ik-detail" x={8} y={8} width={96} height={88} rx={2} />
            <path className="ik-detail" d="M56 8V96" />
            {/* Compartment divisions behind the doors. */}
            <path className="ik-detail" d="M8 40H104 M8 66H104" />
            {/* Paired door handles either side of the seam. */}
            <rect className="ik-detail" x={45} y={46} width={5} height={20} rx={2.5} />
            <rect className="ik-detail" x={62} y={46} width={5} height={20} rx={2.5} />
            {/* Viewing window in the switch door. */}
            <rect className="ik-detail" x={22} y={18} width={28} height={16} rx={1.5} />
            {/* Rating label plate. */}
            <rect className="ik-detail" x={64} y={74} width={28} height={16} rx={1.5} />
          </>
        }
      />
      {/* Roof: three hinged sections over the cable compartments. */}
      <ScatterBox at={at} rest={ROOF} index={2} count={5} r={4}
        top={
          <>
            <path className="ik-detail" d="M39 0V76 M79 0V76" />
            <path className="ik-detail" d="M4 3H114" />
          </>
        }
        front={<path className="ik-detail" d="M4 4H114" />}
      />
      {/* Bushing: round, seated on the roof where the elbows land. */}
      <ScatterBox at={at} rest={BUSHING} index={3} count={5} r={3}
        top={
          <>
            <circle className="ik-detail" cx={8} cy={8} r={6} />
            <circle className="ik-detail" cx={8} cy={8} r={3} />
          </>
        }
        front={
          <>
            <circle className="ik-detail" cx={8} cy={7} r={4} />
            <path className="ik-detail" d="M4 7H12 M8 3V11" />
          </>
        }
      />
      <Press
        label="Flash the PME door handle"
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
                x={1}
                y={4}
                width={3}
                height={12}
                rx={1.5}
              />
            }
          />
        </g>
      </Press>
    </Plate>
  );
}
