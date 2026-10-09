"use client";

import { Box, type Box3, type BoxProps } from "react-isokit";

import type { Part } from "./scatter";

/** One box's worth of scatter maths, resolved for this frame. */
export type At = (rest: Box3, index: number, count: number) => Part;

type ScatterBoxProps = {
  /** Null at rest — the box renders in place with no wrapper. */
  at: At | null;
  rest: Box3;
  index: number;
  count: number;
};

/**
 * A `Box` that carries its own scatter fade.
 *
 * isokit's `Box` renders a `<g>` of faces but has no opacity prop, so the
 * transition needs a wrapper. Fading the group (rather than the box, whose
 * geometry is baked into each face's path) is also what lets a part dim while
 * its position stays rigid.
 */
export function ScatterBox({
  at,
  rest,
  index,
  count,
  ...box
}: ScatterBoxProps & Omit<BoxProps, "x" | "y" | "z" | "w" | "d" | "h">) {
  if (!at) return <Box {...rest} {...box} />;
  const part = at(rest, index, count);
  return (
    <g opacity={part.opacity}>
      <Box {...part.box} {...box} />
    </g>
  );
}