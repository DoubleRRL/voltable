"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { surfaceClasses } from "@/lib/surface-classes";
import { typeClass } from "@/lib/type-scale";
import { Button } from "@/components/ui/button";
import { spring } from "@/lib/springs";

import type { FigureEvidence } from "./types";

/** Floor and ceiling for the resize handle, in viewport units. The image is
 *  line art someone may be reading a dimension off, so it can get large — but
 *  not larger than the screen. */
const MIN_W = 320;
const MAX_W = 1600;
const MIN_H = 240;
const MAX_H = 1200;

type ResizeState = {
  /** Pointer position when the drag started. */
  px: number;
  py: number;
  /** Panel size when the drag started. */
  w: number;
  h: number;
};

/**
 * A figure, full size, in a resizeable lightbox.
 *
 * A thumbnail in the answer is an invitation, not the content: on a live call
 * the planner has to read a dimension off the drawing, and a 112px thumbnail
 * cannot carry one. Clicking opens the full-resolution crop here.
 *
 * Deliberately chromeless: a title row and the drawing, nothing else. The
 * OCR text and the chapter/page line used to live in a footer here, and they
 * read as a second caption competing with the drawing — the caption is in the
 * title, the page is on the thumbnail badge that opened this, and the OCR
 * stays in the index where search uses it.
 *
 * The panel resizes by dragging its corner — the same "throw it bigger"
 * affordance a planner already uses on their Mac — and the image is
 * `object-contain` so a resize never crops a diagram. Clicking anywhere
 * outside the panel closes it; so does Escape. Everything rides the system's
 * spring tiers and surface tokens; the only custom motion is the resize drag
 * itself, which follows the pointer 1:1 and therefore must not be
 * spring-smoothed.
 */
export function FigureLightbox({
  figure,
  onClose,
}: {
  figure: FigureEvidence;
  onClose: () => void;
}) {
  const shape = useShape();
  const reduceMotion = useReducedMotion();
  const [size, setSize] = useState({ w: 880, h: 640 });
  const dragRef = useRef<ResizeState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        px: event.clientX,
        py: event.clientY,
        w: size.w,
        h: size.h,
      };
    },
    [size],
  );

  const onHandlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.px;
    const dy = event.clientY - drag.py;
    // Dragging right/down grows the panel; the corner anchor means the
    // top-left stays put while the bottom-right follows the pointer.
    setSize({
      w: Math.min(MAX_W, Math.max(MIN_W, Math.round(drag.w + dx))),
      h: Math.min(MAX_H, Math.max(MIN_H, Math.round(drag.h + dy))),
    });
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Escape closes, and the panel mounts centered on the first frame.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const content = (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <motion.div
        className="absolute inset-0 bg-black/40 dark:bg-black/80"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduceMotion ? { duration: 0.15, ease: "easeOut" } : spring.moderate}
      />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={figure.caption || `ESR figure on page ${figure.page}`}
          initial={reduceMotion ? { opacity: 0, scale: 0.96 } : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0.15, ease: "easeOut" } : spring.moderate}
          // The centering wrapper covers the screen and would otherwise eat
          // the click; the panel stops the close so only outside clicks land.
          onClick={(event) => event.stopPropagation()}
          className={cn("relative flex flex-col overflow-hidden", surfaceClasses(3, 3), shape.container)}
          style={{ width: size.w, height: size.h }}
        >
          <div
            className={cn(
              "flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border)] px-3 py-2",
            )}
          >
            <span
              className={cn(typeClass("caption"), "min-w-0 truncate text-foreground")}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {figure.caption || `Figure on page ${figure.page}`}
            </span>
            <Button
              type="button"
              variant="tertiary"
              size="icon"
              onClick={onClose}
              aria-label="Close figure"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={figure.figureUrl}
              alt={figure.caption || `ESR figure on page ${figure.page}`}
              className="h-full w-full object-contain"
            />
          </div>

          <div
            aria-hidden
            role="presentation"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute bottom-0 right-0 h-6 w-6 cursor-nwse-resize touch-none"
            style={{
              background:
                "linear-gradient(135deg, transparent 50%, var(--border) 50%)",
            }}
          />
        </motion.div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
