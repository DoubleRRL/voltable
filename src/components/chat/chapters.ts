import type { CSSProperties } from "react";

/**
 * Chapter identity for the ESR.
 *
 * The manual is organised into cohesive chapters and an answer legitimately
 * draws on more than one — a metering question can rest on ESR-5 (Meters) and
 * ESR-3 (Underground) at the same time. When that happens the planner needs to
 * see the split immediately, because "the manual says" is only useful once you
 * know which part said it.
 *
 * So each chapter gets one hue, used identically everywhere a chapter appears:
 * the citation rail, the answer's inline citations, the evidence header. Six
 * chapters are indexed today (ESR-6 is not present in this edition's layout).
 *
 * The colours are categorical, not decorative. They are never the only signal:
 * every chapter is also labelled with its number in text, so the mapping holds
 * in greyscale, for colour-blind readers, and when printed.
 */

/** Chapters actually present in the indexed ESR, in manual order. */
export const ESR_CHAPTERS = [
  "ESR-1", // General Information
  "ESR-2", // Overhead Service Connections 0-600 V
  "ESR-3", // Underground Service Connections 0-600 V
  "ESR-4", // Company-Owned Transformer on Customer's Premises
  "ESR-5", // Meters - EXO Installations
  "ESR-7", // Switchboards Above 600 V
] as const;

export type EsrChapterId = (typeof ESR_CHAPTERS)[number];

/**
 * A chapter's hue, as a single CSS custom property.
 *
 * Only the hue is set here. Every level the badge uses (text, background,
 * border) is derived from it in globals.css, so light and dark each pick their
 * own lightness without this file carrying two themes' worth of colours.
 */
const CHAPTER_HUES: Record<string, number> = {
  "ESR-1": 250, // slate blue — general information
  "ESR-2": 28, // amber — overhead
  "ESR-3": 200, // cyan — underground
  "ESR-4": 330, // magenta — transformer
  "ESR-5": 145, // green — meters
  "ESR-7": 90, // lime — switchboards above 600 V
};

const isKnownChapter = (chapter: string): chapter is EsrChapterId =>
  Object.prototype.hasOwnProperty.call(CHAPTER_HUES, chapter);

/**
 * Style props for a chapter, or an empty object for an unknown one so the
 * caller falls back to neutral rather than inventing a hue.
 */
export const chapterVars = (
  chapter: string | null | undefined
): CSSProperties => {
  const key = chapter?.trim().toUpperCase();
  if (!key || !isKnownChapter(key)) return {};
  return { "--chapter-hue": CHAPTER_HUES[key] } as CSSProperties;
};

/** Short label for dense contexts. */
export const chapterLabel = (chapter: string): string => chapter.trim().toUpperCase();