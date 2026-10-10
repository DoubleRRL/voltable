"use client";

import { useRef, useState } from "react";

import { ManualEvidenceDialog } from "./ManualEvidenceDialog";

import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
} from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { MANUALS, citeLabel, type ManualId } from "@/lib/rag/docs";

import { ChapterBadge } from "./ChapterBadge";
import { chapterVars } from "./chapters";
import type { SourceCitation } from "./types";

/** "ESR-2" reads as a label; a long section path does not. */
const shortSection = (section: string | null | undefined, limit = 42) => {
  const text = section?.trim();
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/**
 * Where the citation is, in the manual's own words.
 *
 * "ESR 3-24" and "DOH AC 370 Sheet 2 of 2" are both printed-page references,
 * but the second has no page number to give: DOH and UGS number standards and
 * sheets, not pages. Showing a PDF index instead would be a reference the
 * planner cannot use in the document itself.
 */
const citationLabel = (citation: SourceCitation) =>
  citeLabel(
    citation.docId,
    citation.pageLabel ?? null,
    citation.chapter ?? null,
    citation.standard ?? citation.chapter ?? null,
    citation.sheetOf ?? null,
    citation.sheetCount ?? null
  );

type CitationRowProps = {
  citation: SourceCitation;
  /** Index in the rail's fluid-hover list. */
  index: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  /** Opens the cited page in the in-app evidence dialog. */
  onOpenPage: (citation: SourceCitation) => void;
};

/**
 * One citation, checkable without opening anything: the page it was printed on,
 * the chapter of the manual it sits in, the section heading, and the quote the
 * answer rests on. A citation a planner has to trust on a summary is a
 * citation they cannot check, and on a utility standard that is the whole job.
 */
function CitationRow({ citation, index, registerItem, onOpenPage }: CitationRowProps) {
  const shape = useShape();
  const rowRef = useRef<HTMLDivElement>(null);

  // Registered in the rail's list, not a list of its own: one hover highlight
  // per list, and these rows are alternatives inside the rail.
  useRegisterFluidHoverItem(registerItem, index, rowRef);

  const section = shortSection(citation.section);
  const chapter = citation.chapter?.trim();
  const manual = MANUALS[citation.docId];

  return (
    <div
      ref={rowRef}
      data-slot="evidence-row"
      data-chapter={chapter ?? undefined}
      style={chapterVars(chapter)}
      className={cn("relative z-10 flex flex-col gap-0.5 px-1 py-1.5", shape.bg)}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Badge variant="dot" color="gray" size="compact" className="tabular-nums">
          {citationLabel(citation)}
        </Badge>
        {manual && manual.classification !== "public" ? (
          <span
            className={cn(typeClass("caption"), "text-muted-foreground")}
            title={`${manual.title} — ${manual.classification}`}
          >
            {manual.classification === "confidential" ? "confidential" : "internal"}
          </span>
        ) : null}
        {chapter ? <ChapterBadge chapter={chapter} variant="rule" /> : null}
        <span
          className={cn(typeClass("body"), "min-w-0 flex-1 truncate text-foreground")}
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          {section ?? MANUALS[citation.docId].code}
        </span>
      </div>
      {citation.quote ? (
        <blockquote className={cn(typeClass("caption"), "border-l border-[color:var(--chapter-rule,var(--border))] pl-2 text-muted-foreground")}>
          {citation.quote}
        </blockquote>
      ) : (
        <p className={cn(typeClass("caption"), "text-muted-foreground")}>
          No excerpt recorded for this citation.
        </p>
      )}
      <Button
        type="button"
        size="compact"
        variant="tertiary"
        onClick={() => onOpenPage(citation)}
        className="w-fit cursor-pointer"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        Open page
      </Button>
    </div>
  );
}

type EvidenceRailProps = {
  citations: SourceCitation[];
  className?: string;
  /** Page to open in the in-app evidence dialog. */
  onOpenPage?: (docId: ManualId, page: number, chapter: string | null, locationLabel: string | null) => void;
};

/**
 * The cited sources for the latest answer, each carrying the exact quote it
 * rests on. A planner deciding whether to trust a number reads the excerpt; the
 * page link is there for the ones who want the scan.
 */
export function EvidenceRail({ citations, className, onOpenPage }: EvidenceRailProps) {
  const shape = useShape();
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);
  const [opened, setOpened] = useState<{
    docId: ManualId;
    page: number;
    chapter: string | null;
    locationLabel: string | null;
  } | null>(null);

  const openPage = (citation: SourceCitation) => {
    const locationLabel = citationLabel(citation);
    if (onOpenPage) {
      onOpenPage(citation.docId, citation.page, citation.chapter ?? null, locationLabel);
      return;
    }
    setOpened({
      docId: citation.docId,
      page: citation.page,
      chapter: citation.chapter ?? null,
      locationLabel,
    });
  };

  return (
    <aside aria-label="Cited sources" className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline gap-2 px-1 pb-1">
        <h2
          className={cn(typeClass("title"), "text-foreground")}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          Sources
        </h2>
        <span className={cn(typeClass("caption"), "tabular-nums text-muted-foreground")}>
          {citations.length}
        </span>
      </div>
      <div
        ref={listRef}
        onMouseEnter={hover.handlers.onMouseEnter}
        onMouseMove={hover.handlers.onMouseMove}
        onMouseLeave={hover.handlers.onMouseLeave}
        onClick={hover.handlers.onClick}
        className={cn("relative flex flex-col gap-0.5", shape.container)}
      >
        <FluidHoverHighlight hover={hover} className={cn("z-0", shape.bg)} />
        {citations.map((citation, index) => (
          <CitationRow
            key={`${citation.docId}-${citation.page}-${index}`}
            citation={citation}
            index={index}
            registerItem={hover.registerItem}
            onOpenPage={openPage}
          />
        ))}
      </div>
      <ManualEvidenceDialog
        docId={opened?.docId ?? null}
        page={opened?.page ?? null}
        chapter={opened?.chapter ?? null}
        locationLabel={opened?.locationLabel ?? null}
        onClose={() => setOpened(null)}
      />
    </aside>
  );
}