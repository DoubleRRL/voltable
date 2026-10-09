"use client";

import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { surfaceClasses } from "@/lib/surface-classes";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import { Button } from "@/components/ui/button";

import { ChapterBadge } from "./ChapterBadge";
import { GroundingBadge } from "./GroundingBadge";
import { FigureCard } from "./FigureCard";
import type { SavedAnswer } from "./useSavedAnswers";

type SavedListProps = {
  saved: SavedAnswer[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onAsk: (question: string) => void;
};

const dateLabel = (ms: number) => {
  const then = new Date(ms);
  const today = new Date();
  const sameDay =
    then.toDateString() === today.toDateString();
  if (sameDay) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/**
 * Saved answers, newest first.
 *
 * A saved answer keeps its citations and its grounding badge, because the point
 * of saving one is to reuse it *and* be able to check it again. Showing the
 * question alone would make this a notepad.
 */
export function SavedList({ saved, onRemove, onClear, onAsk }: SavedListProps) {
  const shape = useShape();
  if (saved.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <p
          className={cn(typeClass("body"), "text-muted-foreground")}
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          No saved answers yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(typeClass("caption"), "text-muted-foreground")}
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          {saved.length} saved
        </span>
        <Button size="compact" variant="tertiary" type="button" onClick={onClear}>
          Clear all
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {saved.map((item) => {
          const chapters = [
            ...new Set(
              item.citations
                .map((citation) => citation.chapter)
                .filter((chapter): chapter is string => Boolean(chapter))
            ),
          ];
          return (
            <li
              key={item.id}
              className={cn("flex flex-col gap-1.5 px-3 py-2.5", surfaceClasses(1, 2), shape.container)}
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onAsk(item.question)}
                  title={item.question}
                  className={cn(typeClass("body"), "min-w-0 flex-1 truncate text-left text-foreground transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]")}
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {item.question}
                </button>
                <Button
                  size="compact"
                  variant="tertiary"
                  type="button"
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${item.question} from saved`}
                >
                  Remove
                </Button>
              </div>

              {item.directAnswer ? (
                <p
                  className={cn(typeClass("caption"), "text-foreground")}
                  style={{ fontVariationSettings: fontWeights.normal }}
                >
                  {item.directAnswer}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-1.5">
                <GroundingBadge grounding={item.grounding} />
                {chapters.map((chapter) => (
                  <ChapterBadge key={chapter} chapter={chapter} />
                ))}
                <span
                  className={cn(typeClass("micro"), "ml-auto text-muted-foreground")}
                  style={{ fontVariationSettings: fontWeights.normal }}
                >
                  {dateLabel(item.savedAt)}
                </span>
              </div>

              {item.figures.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {item.figures.slice(0, 3).map((figure) => (
                    <FigureCard
                      key={figure.id}
                      figure={figure}
                      className="max-w-[220px]"
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}