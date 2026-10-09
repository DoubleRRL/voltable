"use client";

import { Badge } from "@/components/ui/badge";
import type { BadgeColor } from "@/components/ui/badge";

import type { Grounding } from "./types";

/**
 * How well the ESR supports the answer, in the planner's own terms: is this the
 * manual talking, the manual plus a hedge, or nothing we can cite.
 *
 * The label is the whole message. There is no tooltip, because a tooltip here
 * could only explain how the verdict was reached — retrieval thresholds, token
 * coverage — which is the software's business, not the planner's. The badge is
 * only useful if a glance at it changes what they do next.
 */
type GroundingLevel = {
  label: string;
  color: BadgeColor;
};

const LEVELS: Record<Grounding, GroundingLevel> = {
  esr: { label: "ESR", color: "green" },
  partial: { label: "Partial", color: "amber" },
  none: { label: "Not in ESR", color: "red" },
};

export function GroundingBadge({ grounding }: { grounding: Grounding }) {
  const level = LEVELS[grounding];
  return (
    <Badge variant="dot" color={level.color} size="compact">
      {level.label}
    </Badge>
  );
}