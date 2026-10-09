import { NextRequest, NextResponse } from "next/server";

import {
  askQuestionWithRagStreaming,
  normalizeChatPayload,
  type StreamDoneChunk,
  type StreamStatusChunk,
  type StreamTextChunk,
  type StreamUsageChunk,
} from "@/lib/rag/chatPayload";
import type {
  AnswerOutcome,
  AnswerProgressEvent,
  AnswerSink,
  RetrievedProgress,
} from "@/lib/rag/pipeline";
import type { ChatAnswer } from "@/lib/rag/types";

const encoder = new TextEncoder();
const sseHeaders = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
  "X-Accel-Buffering": "no",
};

const sendSSE = (type: string, payload: object) =>
  `event: ${type}\n` + `data: ${JSON.stringify(payload)}\n\n`;

export const maxDuration = 300;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The steps the engine took before it wrote anything, from the retrieval it
 * really did. Every number here comes from that retrieval, which is why they
 * can be sent as they happen rather than reconstructed at the end.
 */
const retrievalStatuses = (
  retrieved: RetrievedProgress,
  cached: boolean
): StreamStatusChunk[] => {
  const statuses: StreamStatusChunk[] = [
    {
      stage: "search",
      label: cached ? "Retrieval from cache" : "Searching the ESR…",
      detail: `${plural(retrieved.totalCandidates, "candidate passage")} · ${Math.round(
        retrieved.confidence * 100
      )}% lexical confidence · ${plural(retrieved.matchedChunks, "passage")} matched`,
    },
  ];

  if (retrieved.totalCandidates === 0) {
    return statuses;
  }

  statuses.push({
    stage: "read",
    label: `Read ${plural(retrieved.totalCandidates, "section")}${
      retrieved.chapters.length > 0 ? ` in ${retrieved.chapters.join(", ")}` : ""
    }`,
    detail:
      retrieved.pages.length > 0
        ? `pages ${retrieved.pages.slice(0, 6).join(", ")}`
        : undefined,
  });

  statuses.push({
    stage: "figures",
    label: `Found ${plural(retrieved.figureCount, "diagram")}`,
    detail: retrieved.figureCount > 0 ? undefined : "no diagrams on the pages read",
  });

  return statuses;
};

const writeStatus = (
  source: "model" | "cache" | "extractive" | "fallback" | "near-miss",
  model: string
): StreamStatusChunk => {
  switch (source) {
    case "model":
      return { stage: "write", label: "Writing…", detail: model };
    case "cache":
      return {
        stage: "write",
        label: "Cached answer",
        detail: "No model call — served from the query cache.",
      };
    case "extractive":
      return {
        stage: "write",
        label: "Writing…",
        detail: "Extractive mode: the ESR sections themselves, no model call.",
      };
    case "fallback":
      return {
        stage: "write",
        label: "Model unavailable",
        detail: "Answered from the retrieved ESR sections instead.",
      };
    case "near-miss":
      return {
        stage: "write",
        label: "Writing…",
        detail: "Nothing cleared the threshold — showing the closest sections.",
      };
  }
};

/** Progress the engine reports, in the words the trail renders. */
const statusEvents = (event: AnswerProgressEvent, model: string): StreamStatusChunk[] => {
  if (event.kind === "cached") {
    return [
      ...retrievalStatuses(event.retrieved, true),
      writeStatus("cache", model),
    ];
  }
  if (event.kind === "retrieved") {
    return retrievalStatuses(event.retrieved, false);
  }
  if (event.kind === "write") {
    return [writeStatus(event.source, model)];
  }
  return [];
};

const usageChunk = (outcome: AnswerOutcome, latencyMs: number): StreamUsageChunk => {
  const { answer, usage } = outcome;
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  return {
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      latency_ms: latencyMs,
      retrieval_latency_ms: answer.retrievalSummary.latencyMs,
      retrieval_candidates: answer.retrievalSummary.totalCandidates,
      retrieval_confidence: answer.retrievalSummary.confidence,
      tokens_source: usage ? "model" : "unavailable",
    },
  };
};

const doneChunk = (
  outcome: AnswerOutcome,
  provider: string,
  model: string,
  usage: StreamUsageChunk
): StreamDoneChunk & { usage: StreamUsageChunk["usage"] } => {
  const answer: ChatAnswer = outcome.answer;
  return {
    message: {
      role: "assistant",
      text: answer.answer,
      directAnswer: answer.directAnswer,
      citations: answer.citations,
      figures: answer.figures,
      exceptions: answer.exceptions ?? [],
      grounding: answer.grounding,
      notCovered: answer.notCovered,
      retrievalSummary: answer.retrievalSummary,
    },
    provider,
    model,
    latencyMs: usage.usage.latency_ms,
    usage: usage.usage,
  };
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const paramsValue = await params;
  const provider = paramsValue?.provider?.trim() || "ollama";

  const body = await request.json().catch(() => null);
  const normalized = normalizeChatPayload(body);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }

  const { question, model, stream: isStream, visualFirst, conversationPrefix } = normalized.value;
  const startedAt = Date.now();

  if (!isStream) {
    try {
      const outcome = await askQuestionWithRagStreaming(question, {
        visualFirst,
        conversationPrefix,
      });
      const usage = usageChunk(outcome, Date.now() - startedAt);
      return NextResponse.json(doneChunk(outcome, provider, model, usage), { status: 200 });
    } catch (error) {
      return NextResponse.json(
        { error: errorMessage(error, "Unable to answer the question.") },
        { status: 500 }
      );
    }
  }

  const abort = new AbortController();
  if (request.signal.aborted) {
    abort.abort();
  } else {
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (type: string, payload: object) => {
        if (!closed) {
          controller.enqueue(encoder.encode(sendSSE(type, payload)));
        }
      };

      const sink: AnswerSink = {
        onEvent: (event) => {
          for (const status of statusEvents(event, model)) {
            emit("status", status);
          }
          if (event.kind === "text") {
            const textChunk: StreamTextChunk = { text: event.delta };
            emit("text", textChunk);
          }
        },
      };

      void (async () => {
        try {
          const outcome = await askQuestionWithRagStreaming(question, {
            visualFirst,
            conversationPrefix,
            sink,
            signal: abort.signal,
          });
          const latencyMs = Date.now() - startedAt;
          const usage = usageChunk(outcome, latencyMs);
          emit("usage", usage);
          emit("done", doneChunk(outcome, provider, model, usage));
        } catch (error) {
          emit("error", {
            error: errorMessage(error, "Unable to answer the question."),
          });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the runtime */
          }
        }
      })();
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: sseHeaders,
  });
}