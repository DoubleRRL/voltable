"use client";

import { cn } from "@/lib/utils";
import { useShape } from "@/lib/shape-context";
import { typeClass } from "@/lib/type-scale";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";

type EsrPdfDialogProps = {
  /** 1-indexed page to open at, or null to open at the front. */
  page: number | null;
  onClose: () => void;
  /** Chapter shown in the title, when the citation carried one. */
  chapter?: string | null;
};

/**
 * The ESR, in a dialog, at the cited page.
 *
 * A citation is only worth something if the planner can check it without
 * leaving the app. Opening a 28 MB PDF in Preview or a new browser tab loses
 * the question, the answer and the rest of the transcript, and on a call there
 * may not be time to get back. This keeps the answer on screen beside the page
 * that settles it.
 *
 * The browser's own PDF viewer is used rather than a canvas renderer: it already
 * handles search, zoom and text selection, and re-implementing it badly would
 * cost more than it saved.
 */
export function EsrPdfDialog({ page, onClose, chapter }: EsrPdfDialogProps) {
  const shape = useShape();
  const open = page !== null;
  // A fragment is the reliable way to open a PDF at a page in Chromium's
  // viewer; the file itself is served by this app from /esr.pdf.
  const src = page ? `/esr.pdf#page=${page}` : "/esr.pdf";

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
            {page ? `ESR page ${page}` : "Electrical Service Requirements"}
            {chapter ? <span className="text-muted-foreground"> · {chapter}</span> : null}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden bg-surface-1">
          {open ? (
            <object
              type="application/pdf"
              data={src}
              className="h-[min(72dvh,900px)] w-full"
              aria-label={page ? `ESR page ${page}` : "Electrical Service Requirements"}
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
                  Open page {page ?? 1}
                </a>
              </div>
            </object>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}