"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

import type { FigureEvidence } from "./types";
import { FigureCard } from "./FigureCard";
import { FigureLightbox } from "./FigureLightbox";

type FigureRowProps = {
  figures: FigureEvidence[];
  className?: string;
  /** Passed through to every card (SavedList caps thumbnail width). */
  cardClassName?: string;
};

/**
 * An answer's thumbnails with one shared lightbox.
 *
 * Each card used to own its open state and mount a lightbox showing only
 * itself, so comparing two drawings meant close-reopen-close-reopen. The open
 * index lives here instead: one dialog, arrow keys move through the row in
 * thumbnail order, and the position reads out in the title. Cards stay dumb —
 * they report which figure was activated and never mount a dialog themselves.
 */
export function FigureRow({ figures, className, cardClassName }: FigureRowProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (figures.length === 0) {
    return null;
  }

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)} aria-label="Figures">
        {figures.map((figure, i) => (
          <FigureCard
            key={figure.id}
            figure={figure}
            className={cardClassName}
            onOpen={() => setOpenIndex(i)}
          />
        ))}
      </div>
      {openIndex !== null ? (
        <FigureLightbox
          figures={figures}
          index={openIndex}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </>
  );
}
