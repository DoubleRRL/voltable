"use client";

import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";

type NotCoveredNoticeProps = {
  chapters?: string[];
  /** True when retrieval itself found nothing, rather than the answer simply
   *  arriving without a citable passage. */
  fromRetrieval?: boolean;
  className?: string;
};

/**
 * The ESR does not cover this.
 *
 * One sentence and the nearest chapters, and nothing else. The grounding badge
 * already says "Not in the ESR", so this must not restate it — a refusal the
 * planner sees three times reads as three separate warnings rather than one
 * clear answer, and buries the thing they actually need: which sections to open.
 *
 * It says what to do next rather than describing a mechanism. "Nothing cleared
 * the retrieval threshold" is about the software; "these are the closest
 * sections" is about their next minute.
 */
export function NotCoveredNotice({
  chapters = [],
  fromRetrieval = false,
  className,
}: NotCoveredNoticeProps) {
  const shape = useShape();

  return (
    <div
      className={cn(
        "flex flex-col gap-1 border border-border px-2.5 py-2",
        shape.bg,
        className
      )}
    >
      <p
        className={cn(typeClass("caption"), "text-muted-foreground")}
        style={{ fontVariationSettings: fontWeights.normal }}
      >
        {fromRetrieval
          ? "Nothing in the manual matched. Don't quote a number from this."
          : "No passage came back to check this against, so treat it as unverified."}
      </p>
      {chapters.length > 0 ? (
        <p
          className={cn(typeClass("caption"), "text-muted-foreground")}
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          Closest: {chapters.join(", ")}
        </p>
      ) : null}
    </div>
  );
}