"use client";

import { useState } from "react";

import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import { spring } from "@/lib/springs";

import type { FigureEvidence } from "./types";
import { FigureLightbox } from "./FigureLightbox";

type FigureCardProps = {
  figure: FigureEvidence;
  className?: string;
};

const THUMB_PX = 112;

/**
 * One diagram as a small thumbnail in the answer's figure row.
 *
 * The thumbnail is an invitation, not the content: on a live call the planner
 * has to read a dimension off the drawing, and a 112px thumbnail cannot carry
 * one. Activating it opens the full-resolution crop in `FigureLightbox`. The
 * previous full-width render made a two-figure answer a wall of white paper;
 * the row below is the whole point of the app without taking the page over.
 *
 * This is also the trust boundary: `figureUrl` arrived as JSON over a stream,
 * so a blank image is worse than no image and a failed load removes the
 * thumbnail instead of showing a broken frame.
 */
export function FigureCard({ figure, className }: FigureCardProps) {
  const shape = useShape();
  const reduceMotion = useReducedMotion();
  const src = (figure.figureUrl ?? "").trim();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Keyed on the resolved URL rather than reset in an effect: a recycled
  // component pointed at a new figure must not stay blank because the previous
  // one 404'd.
  if (!src || failedSrc === src) {
    return null;
  }

  const alt = figure.caption?.trim() || `ESR figure on page ${figure.page}`;

  return (
    <>
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open figure: ${alt}`}
        className={cn(
          "group relative shrink-0 overflow-hidden outline-none",
          "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
          shape.bg,
          className,
        )}
        style={{ width: THUMB_PX, height: THUMB_PX }}
        initial={false}
        whileHover={reduceMotion ? undefined : { scale: 1.04 }}
        whileTap={reduceMotion ? undefined : { scale: 0.97 }}
        transition={spring.fast}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          loading="lazy"
          aria-hidden
          onError={() => setFailedSrc(src)}
          // Diagrams are line art on white. Every pixel matters when someone
          // is reading a dimension off it, so contain, never cover.
          className="h-full w-full bg-white object-contain"
        />
        <span
          className={cn(
            typeClass("micro"),
            "absolute bottom-1 left-1 rounded-sm bg-black/60 px-1 tabular-nums text-white",
          )}
        >
          p.{figure.page}
        </span>
      </motion.button>
      <span className={cn(typeClass("micro"), "sr-only")}>{alt}</span>
      {open ? <FigureLightbox figure={figure} onClose={() => setOpen(false)} /> : null}
    </>
  );
}