import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";

import { chapterVars } from "./chapters";

type ChapterBadgeProps = {
  chapter: string | null | undefined;
  /** `chip` is a filled tint for surfaces that need presence; `rule` is a bare
   * label with a leading bar, for dense rows where a filled chip is too loud. */
  variant?: "chip" | "rule";
  className?: string;
};

/**
 * A chapter badge: the ESR chapter a citation or figure came from, tinted by
 * chapter.
 *
 * An answer can legitimately rest on two chapters at once — a metering question
 * draws on ESR-5 (Meters) and ESR-3 (Underground) — and when it does, seeing
 * that split at a glance is the difference between trusting the answer and
 * re-reading the manual. The chapter number is always written out; the colour
 * only makes the grouping fast to see.
 *
 * Renders nothing when there is no chapter, rather than an empty chip.
 */
export function ChapterBadge({ chapter, variant = "chip", className }: ChapterBadgeProps) {
  const shape = useShape();
  const label = chapter?.trim().toUpperCase();
  if (!label) return null;

  const isChip = variant === "chip";

  return (
    <span
      style={{ ...chapterVars(label), fontVariationSettings: fontWeights.semibold }}
      // The hue lives on the element so the surrounding CSS can derive a
      // matching rule or tint from the same value.
      data-chapter={label}
      className={cn(
        typeClass("micro"),
        "inline-flex items-center gap-1 whitespace-nowrap",
        isChip
          ? "h-5 border px-1.5"
          : "gap-1.5 before:h-3 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[color:var(--chapter-rule)]",
        isChip && shape.item,
        isChip && "border-[color:var(--chapter-border)] bg-[color:var(--chapter-bg)] text-[color:var(--chapter-fg)]",
        className
      )}
    >
      {label}
    </span>
  );
}