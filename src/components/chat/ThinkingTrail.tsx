"use client";

import {
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingStepImage,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
  ThinkingStepSource,
  ThinkingStepSources,
} from "@/components/ui/thinking-steps";
import { typeClass } from "@/lib/type-scale";
import type { IconName } from "@/lib/icon-context";
import { cn } from "@/lib/utils";

import type { AssistantMessage, TrailEvent, TrailStepKey } from "./types";

/** The steps the client narrates when the engine does not narrate them. */
const STEP_LABEL: Record<TrailStepKey, string> = {
  search: "Searching ESR",
  read: "Read sections",
  figures: "Found diagrams",
  write: "Writing",
};

/** Cited pages, de-duplicated and in ascending order. */
const uniquePages = (message: AssistantMessage): number[] => {
  const pages = new Set(message.citations.map((citation) => citation.page));
  return [...pages].sort((a, b) => a - b);
};

/**
 * The trail for a stream that reported no `status` events — which is every
 * stream until the engine starts reporting them. It still has to be legible:
 * the counts come from the `done` payload's retrieval summary, so the numbers
 * shown are the real ones, just reported at the end instead of as they happen.
 */
const deriveSteps = (message: AssistantMessage): TrailEvent[] => {
  const steps: TrailEvent[] = [
    {
      id: "search",
      key: "search",
      label: STEP_LABEL.search,
      detail: message.retrievalSummary?.totalCandidates
        ? `${message.retrievalSummary.totalCandidates} passages scored`
        : undefined,
    },
  ];

  const sections = message.retrievalSummary?.matchedChunks ?? message.citations.length;
  if (sections > 0) {
    steps.push({
      id: "read",
      key: "read",
      label: `Read ${sections} section${sections === 1 ? "" : "s"}`,
    });
  }

  if (message.figures.length > 0) {
    steps.push({
      id: "figures",
      key: "figures",
      label: `Found ${message.figures.length} diagram${message.figures.length === 1 ? "" : "s"}`,
    });
  }

  if (message.content.trim() || message.streaming) {
    steps.push({ id: "write", key: "write", label: STEP_LABEL.write });
  }

  return steps;
};

/**
 * Server-reported steps win: they are the real progress and carry detail the
 * client cannot invent. The derived trail only fills in when the stream
 * reported nothing, so a `text`+`done` stream still shows what was read and
 * which diagrams came back.
 */
const resolveSteps = (message: AssistantMessage): TrailEvent[] =>
  message.trailEvents.length > 0 ? message.trailEvents : deriveSteps(message);

/** Everything before the active step is done; the active one shimmers; the rest
 *  have not started (and ThinkingSteps renders pending steps as nothing). */
const stepStatus = (index: number, activeIndex: number) =>
  index < activeIndex ? ("complete" as const) : ("active" as const);

const iconForStep = (key: TrailStepKey | null, isLast: boolean): IconName => {
  if (key === "figures") {
    return "image";
  }
  if (key === "write") {
    return "pencil";
  }
  return isLast ? "check" : "dot";
};

const describeRetrieval = (message: AssistantMessage) => {
  const summary = message.retrievalSummary;
  if (!summary) {
    return "The engine did not report a retrieval summary for this answer.";
  }
  const parts = [
    `${summary.totalCandidates} candidate passages`,
    `${summary.matchedChunks} matched`,
  ];
  // The engine reports these only once retrieval settles; a summary that
  // omits them still describes what came back, just less precisely.
  const chapters = summary.chapters ?? [];
  if (chapters.length > 0) {
    parts.push(chapters.join(", "));
  }
  if (summary.intent && summary.intent !== "none") {
    parts.push(`intent: ${summary.intent}`);
  }
  if (summary.latencyMs > 0) {
    parts.push(`${(summary.latencyMs / 1000).toFixed(1)}s`);
  }
  return parts.join(" · ");
};

type ThinkingTrailProps = {
  message: AssistantMessage;
  className?: string;
};

/**
 * The retrieval trail: what the engine did between the question and the answer,
 * with the diagrams it found inline and the pages it read as source badges.
 *
 * This is the affordance that makes retrieval legible instead of magic — on a
 * live call a planner needs to see that the ESR actually had the diagram, not
 * just be told the answer is grounded.
 */
export function ThinkingTrail({ message, className }: ThinkingTrailProps) {
  const steps = resolveSteps(message);
  if (steps.length === 0) {
    return null;
  }

  // While streaming, the last step is the one in flight. Once settled, the
  // active marker moves past the end so no step keeps shimmering.
  const activeIndex = message.streaming ? steps.length - 1 : steps.length;
  const lastIndex = steps.length - 1;
  const pages = uniquePages(message);
  const usedFallbackTrail = message.trailEvents.length === 0;

  return (
    <div className={cn("not-typeset", className)}>
      <ThinkingSteps size="compact" defaultOpen={message.streaming}>
        <ThinkingStepsHeader>
          {message.streaming ? "Working" : "How this was found"}
        </ThinkingStepsHeader>
        <ThinkingStepsContent>
          {steps.map((step, index) => {
            const key = step.key;
            // The figures belong to the diagrams step, whichever trail named it.
            const figures = key === "figures" ? message.figures : [];
            return (
              <ThinkingStep
                key={step.id}
                icon={iconForStep(key, index === lastIndex)}
                label={step.label}
                description={step.detail}
                status={stepStatus(index, activeIndex)}
                isLast={index === lastIndex && !usedFallbackTrail}
              >
                {key === "read" && pages.length > 0 ? (
                  <ThinkingStepSources>
                    {pages.map((page) => (
                      <ThinkingStepSource key={page}>
                        p.{page}
                      </ThinkingStepSource>
                    ))}
                  </ThinkingStepSources>
                ) : null}
                {figures.map((figure) => (
                  <ThinkingStepImage
                    key={figure.id}
                    src={figure.figureUrl}
                    alt={figure.caption || `ESR figure on page ${figure.page}`}
                    caption={`p.${figure.page}`}
                  />
                ))}
              </ThinkingStep>
            );
          })}
          {!message.streaming && usedFallbackTrail ? (
            <ThinkingStepDetails summary="Retrieval detail">
              <span className={cn(typeClass("caption", "compact"), "block text-muted-foreground")}>
                {describeRetrieval(message)}
              </span>
            </ThinkingStepDetails>
          ) : null}
        </ThinkingStepsContent>
      </ThinkingSteps>
    </div>
  );
}
