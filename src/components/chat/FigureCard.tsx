"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { surfaceClasses } from "@/lib/surface-classes";
import { typeClass } from "@/lib/type-scale";

import type { FigureEvidence } from "./types";

/** The OCR of one figure runs to a few thousand characters at the long end.
 *  Enough to check a dimension against the drawing, not enough to bury it. */
const OCR_PREVIEW_CHARS = 700;

type FigureCardProps = {
  figure: FigureEvidence;
  className?: string;
};

/**
 * One diagram, inline in the answer.
 *
 * This is the whole point of the app: on a live call the planner needs the
 * drawing, not a page number. So a figure with no renderable image renders
 * nothing at all — the page link still lives in the evidence rail, where a
 * citation without a picture belongs.
 */
export function FigureCard({ figure, className }: FigureCardProps) {
  const shape = useShape();
  // `figureUrl` is the crop, which is what ingest writes for every catalogued
  // asset. The empty check is the trust boundary: this URL arrived as JSON over
  // a stream, and a blank image is worse than no image.
  const src = (figure.figureUrl ?? "").trim();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // Keyed on the resolved URL rather than reset in an effect: a recycled
  // component pointed at a new figure must not stay blank because the previous
  // one 404'd.
  if (!src || failedSrc === src) {
    return null;
  }

  const alt = figure.caption?.trim() || `ESR figure on page ${figure.page}`;
  const ocr = figure.ocrText?.trim() ?? "";
  const ocrPreview =
    ocr.length > OCR_PREVIEW_CHARS ? `${ocr.slice(0, OCR_PREVIEW_CHARS).trimEnd()}…` : ocr;

  return (
    <figure
      className={cn(
        "flex flex-col gap-1.5 p-2",
        surfaceClasses(1, 1),
        shape.bg,
        className
      )}
    >
      <a
        href={figure.sourceLink}
        target="_blank"
        rel="noreferrer"
        className="block rounded-[2px] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailedSrc(src)}
          // Diagrams are line art on white. Every pixel matters when someone
          // is reading a dimension off it, so contain, never cover.
          className="w-full object-contain outline-1 -outline-offset-1 outline-[color:var(--border)]"
        />
      </a>
      {ocrPreview ? (
        // A native disclosure: keyboard-reachable with no JS, and it keeps the
        // transcribed dimension out of the way until someone wants to check it.
        <details className="group">
          <summary
            className={cn(
              typeClass("micro"),
              "w-fit cursor-pointer list-none text-muted-foreground",
              "hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]"
            )}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            Text inside the figure
          </summary>
          <pre className={cn(typeClass("micro"), "mt-1 max-h-64 overflow-auto whitespace-pre-wrap border-l border-border pl-2 text-muted-foreground")}>
            {ocrPreview}
          </pre>
        </details>
      ) : null}
      {figure.caption?.trim() ? (
        <figcaption className={cn(typeClass("caption"), "flex flex-wrap items-baseline gap-x-2 text-muted-foreground")}>
          <span className="text-foreground">{figure.caption.trim()}</span>
          <a
            href={figure.sourceLink}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-current underline-offset-2 transition-colors hover:decoration-foreground"
          >
            {figure.chapter ? `${figure.chapter} · ` : ""}page {figure.page}
          </a>
        </figcaption>
      ) : null}
    </figure>
  );
}