export type ChunkType = "text" | "table" | "figure" | "caption";
export type EvidenceType = "paragraph" | "table" | "figure";

import type { ManualId } from "./docs";

/** Ingestion / retrieval role (body vs narrative–visual pairs). */
export type ChunkRole =
  | "body"
  | "pre_visual_narrative"
  | "visual_caption"
  /** OCR text transcribed from inside a figure crop. */
  | "diagram_ocr"
  /** Legacy; no longer emitted by ingest (fought retrieval). */
  | "full_page_aux";

/** Kind of indexed visual artifact (captions / keywords). */
export type VisualKind = "table" | "figure" | "diagram";

/**
 * Manual chapter or standard number, e.g. "ESR-3", "ADS-10", "PLM-2", and for
 * the sheet-numbered manuals the standard itself ("AC 120", "SS 564").
 *
 * The manuals are organised into cohesive chapters and a question about one
 * topic almost always answers within it, so the chapter is both a filter and a
 * retrieval prior. Sheet-numbered manuals have no pages to filter on, which is
 * why the standard number carries the same weight a chapter does here.
 */
export type ManualChapter = string;

/** How a citation points at a location: a printed page, or a standard sheet. */
export type LocationInManual = {
  /** Printed page label on page-numbered manuals: "3-24". */
  pageLabel?: string | null;
  /** Standard number on sheet-numbered manuals: "AC 120". */
  standard?: string | null;
  sheetOf?: number | null;
  sheetCount?: number | null;
};

/** How an answer's support relates to the manuals. */
export type Grounding = "esr" | "partial" | "none";

export interface SourceCitation extends LocationInManual {
  /** Which manual this came from. */
  docId: ManualId;
  /** PDF page index; only ever used to address stored evidence, never shown. */
  page: number;
  section?: string | null;
  chapter?: string | null;
  quote: string;
  sourceLink: string;
  /** Character offsets of `quote` within the source chunk text, when verified. */
  quoteStart?: number;
  quoteEnd?: number;
}

/** Note / exception extracted at ingest (not invented at query time). */
export interface StoredException {
  text: string;
  page?: number;
  sourceLink?: string;
}

/** Optional text layers attached to a visual asset (caption, table MD, OCR). */
export interface VisualAssetTextLayers {
  caption?: string;
  tableMarkdown?: string;
  ocr?: string;
  [key: string]: string | undefined;
}

/** Cataloged table / figure / diagram with section path + exceptions. */
export interface VisualAsset extends LocationInManual {
  id: string;
  /** Which manual the crop came from. */
  docId: ManualId;
  /** PDF page index the bbox was measured against. */
  page: number;
  kind: VisualKind;
  chapter: string | null;
  sectionKey: string | null;
  sectionPath: string | null;
  caption: string;
  /** Cropped figure image. Preferred for display. */
  figureUrl: string | null;
  /** Full rendered page image. Fallback when a crop is unavailable. */
  thumbnailUrl: string | null;
  /** Normalized crop box in page coords, for debugging and re-cropping. */
  bbox: [number, number, number, number] | null;
  sourceLink: string;
  pairGroupId: string | null;
  exceptions: StoredException[];
  supportingChunkIds: string[];
  textLayers: VisualAssetTextLayers;
  createdAt: number;
}

export interface IndexedChunk extends LocationInManual {
  id: string;
  docId: ManualId;
  page: number;
  chunkType: ChunkType;
  evidenceType: EvidenceType;
  text: string;
  section?: string | null;
  sectionKey?: string | null;
  chapter?: ManualChapter | null;
  /** Standard number on sheet-numbered manuals, kept beside `chapter`. */
  standard?: string | null;
  sourceLink: string;
  embedding?: number[];
  visualPath?: string | null;
  createdAt: number;
  /** Semantic role for narrative ↔ visual pairing. */
  chunkRole: ChunkRole;
  visualKind?: VisualKind | null;
  /** Bidirectional links to paired chunks (JSON array in DB). */
  pairedChunkIds: string[];
  pairGroupId?: string | null;
}

export interface StoredChunk extends IndexedChunk {
  embedding: number[];
}

export interface RetrievalInput {
  question: string;
}

export interface FigureEvidence extends LocationInManual {
  id: string;
  /** Which manual the crop came from. */
  docId: ManualId;
  page: number;
  caption: string;
  sourceLink: string;
  chapter: string | null;
  /** Cropped figure image. */
  figureUrl: string;
  /** Text transcribed from inside the figure, for search and citation. */
  ocrText: string | null;
}

export interface RetrievalResult {
  chunk: StoredChunk;
  score: number;
  confidence: number;
}

export interface ChatAnswer {
  answer: string;
  directAnswer: string;
  citations: SourceCitation[];
  figures: FigureEvidence[];
  /** Stored exceptions attached from visual assets (ingest-time only). */
  exceptions?: StoredException[];
  /** Whether the manuals support this answer, partially, or not at all. */
  grounding: Grounding;
  /** True when nothing in the manuals cleared the retrieval threshold. */
  notCovered: boolean;
  retrievalSummary: {
    totalCandidates: number;
    matchedChunks: number;
    /** Blended lexical confidence, 0..1. Reported, not used as the gate. */
    confidence: number;
    /** Fraction of the question's content tokens found in the best chunk. */
    coverage: number;
    notCovered: boolean;
    /** Why retrieval ran the way it did: figure-word / measurement / none. */
    intent: string;
    chapters: ManualChapter[];
    /** Which manuals contributed evidence, so a planner knows what was searched. */
    docs: ManualId[];
    latencyMs: number;
  };
}
