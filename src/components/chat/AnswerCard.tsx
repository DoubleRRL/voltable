"use client";

import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { surfaceClasses } from "@/lib/surface-classes";
import { typeClass } from "@/lib/type-scale";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ThinkingIndicator } from "@/components/ui/thinking-indicator";
import { Collapsible } from "@base-ui/react/collapsible";
import { motion } from "framer-motion";

import { spring } from "@/lib/springs";
import { FigureRow } from "./FigureRow";
import { EvidenceRail } from "./EvidenceRail";
import { GroundingBadge } from "./GroundingBadge";
import { NotCoveredNotice } from "./NotCoveredNotice";
import type { SavedAnswer } from "./useSavedAnswers";
import type { AssistantMessage, StoredException } from "./types";

/**
 * Splits prose into paragraphs on blank lines. The answer arrives as plain text,
 * not HTML, and this app adds no markdown parser — so the text is rendered as
 * text and only the block structure is derived. Nothing is ever injected as
 * markup.
 */
const toParagraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

function AnswerProse({ content }: { content: string }) {
  const paragraphs = toParagraphs(content);
  if (paragraphs.length === 0) {
    return null;
  }
  return (
    // `.typeset` is the library's prose sheet: it reads the type-scale tokens
    // and puts whole-pixel rhythm between blocks. Paragraphs go in as <p>
    // elements, never `text-wrap: pretty` on the container, so streamed text
    // appends without re-wrapping the lines already on screen.
    <div className="typeset">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

function Exceptions({ exceptions }: { exceptions: StoredException[] }) {
  if (exceptions.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <h3
        className={cn(typeClass("caption"), "text-muted-foreground")}
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        Exceptions
      </h3>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        {exceptions.map((exception, index) => (
          <li
            key={index}
            className={cn(typeClass("body"), "text-muted-foreground")}
          >
            {exception.page != null ? (
              <span className="tabular-nums text-foreground">p.{exception.page}</span>
            ) : null}{" "}
            {exception.text}
            {exception.sourceLink ? (
              <a
                href={exception.sourceLink}
                target="_blank"
                rel="noreferrer"
                className="ml-1 underline decoration-current underline-offset-2 transition-colors hover:decoration-foreground"
              >
                page
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The direct answer plus the full prose, the full prose folded away. */
function DirectAnswer({
  message,
  expanded,
  onToggle,
}: {
  message: AssistantMessage;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const shape = useShape();
  const hasProse = message.content.trim().length > 0;
  const summary = message.directAnswer.trim();

  return (
    <div className="flex flex-col gap-2">
      {summary && (hasProse || !message.notCovered) ? (
        <p
          className={cn(typeClass("title"), "text-balance text-foreground")}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {summary}
        </p>
      ) : null}
      {hasProse && summary && !message.notCovered ? (
        <Collapsible.Root open={expanded} onOpenChange={onToggle}>
          <Collapsible.Trigger className={cn("flex w-fit cursor-pointer items-center gap-1.5 px-1.5 py-0.5 text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]", shape.button)}>
            {expanded ? "Hide full answer" : "Read full answer"}
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={spring.fast} className="inline-flex">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden>
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </motion.span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <div className="pt-2">
              <AnswerProse content={message.content} />
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : hasProse ? (
        <AnswerProse content={message.content} />
      ) : null}
    </div>
  );
}

/** What a save needs from this answer. The question is filled in by `Message`,
 *  which is the only component that knows which user turn this answers. */
type SavePayload = Pick<
  SavedAnswer,
  | "id"
  | "answer"
  | "directAnswer"
  | "citations"
  | "figures"
  | "grounding"
  | "notCovered"
>;

type AnswerCardProps = {
  message: AssistantMessage;
  expandedProse: boolean;
  onProseOpenChange: (open: boolean) => void;
  /** Present once the stream settles; omitted while writing. */
  onSave?: (entry: SavePayload) => void;
  saved?: boolean;
};

/**
 * The assistant's answer: the one-line answer, the prose behind it, the stored
 * exceptions that came with the cited visuals, the diagrams as small
 * thumbnails, and the sources underneath — answer, figures, sources, in that
 * order, the way a planner reads them.
 */
export function AnswerCard({
  message,
  expandedProse,
  onProseOpenChange,
  onSave,
  saved,
}: AnswerCardProps) {
  const shape = useShape();
  const figures = message.figures;
  const chapters = message.retrievalSummary?.chapters ?? [];
  const hasSources = message.citations.length > 0;

  // While the answer is still arriving, show only the orb — no card, no
  // partial words. Half-sentences on screen read as findings before there is
  // one, and the full card lands when the stream settles. Errors still show:
  // a failed stream must say so, not spin forever.
  if (message.streaming && !message.error) {
    return <ThinkingIndicator className="px-0 py-0" />;
  }

  return (
    <Card
      className={cn("gap-3 p-3", surfaceClasses(1, 2), shape.container)}
    >
      <div className="flex items-center justify-between gap-2">
        {/* While streaming there is no verdict and no prose yet — just the
            orb. Text statuses ("Checking…", "Writing…") narrated the plumbing
            instead of the state; the indicator announces one "Thinking…" to
            assistive tech and shows the morphing glyph to everyone else. */}
        {message.streaming ? (
          <ThinkingIndicator className="px-0 py-0" />
        ) : (
          <GroundingBadge grounding={message.grounding} />
        )}
        <div className="flex items-center gap-2">
          {!message.streaming && onSave ? (
            <Button
              size="compact"
              variant="tertiary"
              type="button"
              onClick={() =>
                onSave({
                  id: message.id,
                  answer: message.content,
                  directAnswer: message.directAnswer,
                  citations: message.citations,
                  figures: message.figures,
                  grounding: message.grounding,
                  notCovered: message.notCovered,
                })
              }
              aria-pressed={saved}
              className="aria-pressed:border-[color:var(--chapter-border,color:var(--border))] aria-pressed:text-foreground"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {saved ? "Saved" : "Save"}
            </Button>
          ) : null}
        </div>
      </div>

      <DirectAnswer
        message={message}
        expanded={expandedProse}
        onToggle={onProseOpenChange}
      />

      <Exceptions exceptions={message.exceptions} />

      {figures.length > 0 ? <FigureRow figures={figures} /> : null}

      {hasSources && !message.notCovered ? (
        <div className="border-t border-[color:var(--border)] pt-2">
          <EvidenceRail citations={message.citations} />
        </div>
      ) : null}

      {message.notCovered ? (
        <NotCoveredNotice
          chapters={chapters}
          fromRetrieval={message.retrievalSummary?.notCovered === true}
        />
      ) : null}

      {message.error ? (
        <p
          role="alert"
          className={cn(typeClass("body"), "text-destructive")}
        >
          {message.error}
        </p>
      ) : null}
    </Card>
  );
}
