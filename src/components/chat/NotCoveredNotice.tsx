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
 * One sentence and the nearest chapters, and nothing else — every word here
 * is planner-facing. The grounding badge already says "Not in the ESR", so
 * this must not restate it, and it must never carry instructions meant for
 * the model ("don't quote a number" is the software's business, not the
 * planner's). What remains is what they actually need: nothing matched, and
 * which sections to open.
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
          ? "Nothing in the manual matched."
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