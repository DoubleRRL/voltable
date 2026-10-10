"use client";

import { Badge } from "@/components/ui/badge";
import type { BadgeColor } from "@/components/ui/badge";

import type { Grounding } from "./types";

/**
 * How well the manuals support the answer, in the planner's own terms: is this
 * the standards talking, the standards plus a hedge, or nothing we can cite.
 *
 * The labels name the corpus rather than one manual on purpose. It was "ESR"
 * when the ESR was all there was; with DOH, UGS, PLM and ADS indexed too, a
 * badge reading "ESR" beside a DOH citation would be a claim about provenance
 * that the answer does not make.
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
  esr: { label: "Supported", color: "green" },
  partial: { label: "Partial", color: "amber" },
  none: { label: "Not in manuals", color: "red" },
};

export function GroundingBadge({ grounding }: { grounding: Grounding }) {
  const level = LEVELS[grounding];
  return (
    <Badge variant="dot" color={level.color} size="compact">
      {level.label}
    </Badge>
  );
}