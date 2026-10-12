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
 * Omni-Rupter load-break switch on a pole, after ADS 10 Fig 10–12 (p65).
 *
 * The device is a horizontal polymer insulator with sheds between two metal
 * end fittings, hung off the pole on a bracket, with the operating link
 * dropping below the blade. The photo shows exactly this: ribbed grey body,
 * cast end caps, a flat mounting strap, and the lever below. Nothing here
 * is a cutout — there is no hinged fuse tube and no arc-follower loop, which
 * is what kept the earlier cutout figure from reading as a switch.
 *
 * All connected parts share one depth so their faces meet instead of
 * floating past each other, and every joint overlaps by four or more units —
 * hairline butt joints separate in projection.
 */
const POLE: Box3 = { x: 118, y: 92, z: 0, w: 18, d: 18, h: 150 };

/** Mounting bracket carrying the switch off the pole face. */
const MOUNT: Box3 = { x: 100, y: 90, z: 108, w: 22, d: 14, h: 8 };

/** Insulator body: horizontal, shed-covered, between the end fittings. */
const BODY: Box3 = { x: 34, y: 92, z: 112, w: 70, d: 14, h: 14 };

/** Line-side cast end fitting. */
const END_LINE: Box3 = { x: 22, y: 92, z: 110, w: 14, d: 14, h: 18 };

/** Load-side cast end fitting, bolted through to the bracket. */
const END_LOAD: Box3 = { x: 100, y: 92, z: 110, w: 12, d: 14, h: 18 };

/** Operating link dropping from the blade to the handle. */
const LINK: Box3 = { x: 62, y: 92, z: 80, w: 6, d: 6, h: 32 };

/** Line in at the line end's height. */
const LINE_PTS: Vec3[] = [
  [0, 92, 119],
  [8, 92, 119],
  [15, 92, 119],
  [22, 92, 119],
];
/** Load out from the load end to the pole face. */
const LOAD_PTS: Vec3[] = [
  [112, 92, 119],
  [114, 92, 119],
  [116, 92, 119],
  [118, 92, 119],
];
/** Bypass jumper slung under the body, end to end. */
const JUMPER_PTS: Vec3[] = curve(
  [26, 92, 110],
  [40, 92, 92],
  [88, 92, 92],
  [106, 92, 110],
);

const SWITCH_BOXES = [POLE, MOUNT, BODY, END_LINE, END_LOAD, LINK];
const SWITCH_WIRES = [...LINE_PTS, ...LOAD_PTS, ...JUMPER_PTS];
const SWITCH_FIELD = field(SWITCH_BOXES, SWITCH_WIRES);

/** Sheds on the horizontal body: vertical ribs, evenly spaced. */
const BODY_SHEDS =
  Array.from({ length: 12 }, (_, i) => `M${5 + i * 5} 0V14`).join(" ");

/**
 * Omni-Rupter pole switch.
 *
 * ADS 10 Fig 10–12: line into one cast end, load out of the other, the
 * operating link hanging below the blade. Pressing flashes the blade
 * contact; the flash is the whole output.
 */
export function SwitchFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 6;
  const at = transition ? parts(SWITCH_FIELD, transition) : null;
  const wireVeil = transition ? veil(transition.progress, transition.phase === "out") : 1;

  const wires = (
    <g>
      <path className="ik-line" d={makePath(LINE_PTS)} />
      <path className="ik-line" d={makePath(LOAD_PTS)} />
      <path className="ik-line" d={makePath(JUMPER_PTS)} />
    </g>
  );

  return (
    <Plate
      label="Omni-Rupter pole switch"
      aspect={1}
      fit={[...SWITCH_BOXES, ...SWITCH_WIRES]}
      theme="system"
      className="iso-figure iso-omnirupter"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={7}
        top={<circle className="ik-detail" cx={10} cy={10} r={7} />}
        front={<path className="ik-detail" d="M5 8V144 M13 8V144" />}
      />
      <ScatterBox at={at} rest={MOUNT} index={1} count={N} r={2}
        front={<path className="ik-detail" d="M1 4H21 M11 0V8" />}
      />
      <ScatterBox at={at} rest={BODY} index={2} count={N} r={3}
        front={
          <>
            <path className="ik-detail" d={BODY_SHEDS} />
            <path className="ik-detail" d="M0 7H70" />
          </>
        }
      />
      <ScatterBox at={at} rest={END_LINE} index={3} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M1 4H13 M1 14H13" />
            <circle className="ik-detail" cx={7} cy={9} r={2.5} />
          </>
        }
      />
      <ScatterBox at={at} rest={END_LOAD} index={4} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d="M1 4H11 M1 14H11" />
            <circle className="ik-detail" cx={6} cy={9} r={2.5} />
          </>
        }
      />
      <Press
        label="Flash the switch blade contact"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          {/* Operating link: the blade contact it pulls is the flash point. */}
          <ScatterBox at={at} rest={LINK} index={5} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d="M3 0V32" />
                {/* Curved handle sweeping below, as the Fig 10–12 photo shows. */}
                <path className="ik-detail" d="M3 32C3 38 -2 40 -2 45" />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={1}
                  y={2}
                  width={4}
                  height={7}
                  rx={2}
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
