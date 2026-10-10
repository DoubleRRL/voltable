"use client";

import { cn } from "@/lib/utils";
import { MANUALS, evidencePageLink, type ManualId } from "@/lib/rag/docs";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ManualEvidenceDialogProps = {
  /** Manual the citation came from, or null when nothing is open. */
  docId: ManualId | null;
  /** 1-indexed PDF page to open at, or null to open at the front. */
  page: number | null;
  onClose: () => void;
  /** Chapter or standard number shown in the title, when known. */
  chapter?: string | null;
  /** Printed page label or sheet label, shown so it matches the citation row. */
  locationLabel?: string | null;
};

/**
 * The cited page, in a dialog, beside the answer.
 *
 * A citation is only worth something if the planner can check it without
 * leaving the app. Opening a PDF in Preview or a new browser tab loses the
 * question, the answer and the rest of the transcript, and on a call there may
 * not be time to get back.
 *
 * It is not the manual. The manual is not in the bundle — 2,591 pages of
 * source PDF would dwarf the app — so this opens the single-page derivative
 * generated for the cited location, which carries that page's real text and
 * vector drawing rather than a screenshot of it. The browser's own viewer is
 * used rather than a canvas renderer: it already handles search, zoom and text
 * selection, and re-implementing it badly would cost more than it saved.
 */
export function ManualEvidenceDialog({
  docId,
  page,
  onClose,
  chapter,
  locationLabel,
}: ManualEvidenceDialogProps) {
  const shape = useShape();
  const open = page !== null && docId !== null;
  const manual = docId ? MANUALS[docId] : null;
  // The derivative is already the cited page, so no page fragment is needed.
  const src = open ? evidencePageLink(docId as ManualId, page as number) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size="lg"
        className={cn("max-h-[90dvh] overflow-hidden p-0")}
        showCloseButton
      >
        <DialogHeader className="px-4 py-3">
          <DialogTitle>
            {manual ? manual.title : "Cited page"}
            {locationLabel || chapter ? (
              <span className="text-muted-foreground">
                {" · "}
                {locationLabel ?? chapter}
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden bg-surface-1">
          {open ? (
            <object
              type="application/pdf"
              data={src}
              className="h-[min(72dvh,900px)] w-full"
              aria-label={
                manual
                  ? `${manual.title}${locationLabel ? `, ${locationLabel}` : ""}`
                  : "Cited page"
              }
            >
              {/* Shown when the browser cannot render a PDF inline — Safari
                  without the viewer, and any browser with the plugin off. */}
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <p className={cn(typeClass("body"), "text-muted-foreground")}>
                  This browser can&apos;t show the PDF here.
                </p>
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(typeClass("caption"), shape.button, "border border-border px-2.5 py-1 text-foreground underline underline-offset-2")}
                >
                  Open the cited page
                </a>
              </div>
            </object>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}