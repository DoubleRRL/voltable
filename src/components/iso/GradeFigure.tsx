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
 * Pole setting at the groundline, after PLM Fig 17 (p172).
 *
 * The drawing measures attachment height from a single point: the groundline
 * where the pole meets grade. The rule stands on grade beside the pole, its
 * foot at the GL mark, reading up to the attachment. The tag rides high on
 * the pole face. What makes it read as a setting measurement rather than a
 * pole portrait is the rule standing apart from the pole with nothing between
 * them but air.
 */
const POLE: Box3 = { x: 60, y: 90, z: 30, w: 26, d: 26, h: 120 };

/** Grade band; its top edge is the groundline. */
const GRADE: Box3 = { x: 35, y: 86, z: 44, w: 76, d: 26, h: 10 };

/** Measuring rule standing on grade beside the pole. */
const RULE: Box3 = { x: 96, y: 92, z: 54, w: 4, d: 4, h: 62 };

/** Pole tag nailed above the rule's reach. */
const TAG: Box3 = { x: 66, y: 88, z: 122, w: 14, d: 6, h: 10 };

const GRADE_BOXES = [POLE, GRADE, RULE, TAG];
const GRADE_FIELD = field(GRADE_BOXES, []);

/** Earth hatching on the grade band. */
const HATCH =
  Array.from({ length: 8 }, (_, i) => `M${5 + i * 8} 10L${9 + i * 8} 0`).join(" ");

/** Foot ticks up the rule. */
const TICKS =
  Array.from({ length: 11 }, (_, i) => `M0 ${4 + i * 5}H4`).join(" ");

/**
 * Pole setting at grade.
 *
 * PLM Fig 17: the groundline is the zero of every attachment height, the
 * rule reads from it, the tag sits above. Pressing flashes the rule's foot
 * at the groundline; the flash is the whole output.
 */
export function GradeFigure({ transition }: { transition?: Transition }) {
  const [pulses, setPulses] = useState(0);

  const N = 4;
  const at = transition ? parts(GRADE_FIELD, transition) : null;

  return (
    <Plate
      label="Pole setting at grade"
      aspect={1}
      fit={GRADE_BOXES}
      theme="system"
      className="iso-figure iso-grade"
    >
      <ScatterBox at={at} rest={POLE} index={0} count={N}
        r={8}
        top={<circle className="ik-detail" cx={14} cy={14} r={8} />}
        front={<path className="ik-detail" d="M6 8V114 M13 8V114 M20 8V114" />}
      />
      <ScatterBox at={at} rest={GRADE} index={1} count={N} r={2}
        front={
          <>
            <path className="ik-detail" d={HATCH} />
            {/* The groundline itself: the top edge the rule reads from. */}
            <path className="ik-detail" d="M0 0H76" />
          </>
        }
      />
      <Press
        label="Flash the groundline mark"
        sound={false}
        disabled={transition !== undefined}
        onPress={() => setPulses((n) => n + 1)}
      >
        <g>
          <ScatterBox at={at} rest={RULE} index={2} count={N}
            r={2}
            front={
              <>
                <path className="ik-detail" d={TICKS} />
                <rect
                  key={pulses}
                  className={pulses === 0 ? "ik-live" : "ik-live glow-target"}
                  x={0}
                  y={56}
                  width={4}
                  height={6}
                  rx={1}
                />
              </>
            }
          />
        </g>
      </Press>
      <ScatterBox at={at} rest={TAG} index={3} count={N} r={2}
        front={<path className="ik-detail" d="M1 1H13 M1 9H13 M7 3V7" />}
      />
    </Plate>
  );
}
