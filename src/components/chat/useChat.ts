"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AssistantMessage,
  ChatApiTurn,
  ChatMessage,
  Grounding,
  RetrievalSummary,
  SourceCitation,
  StreamDoneBody,
  StreamStatusChunk,
  StreamUsageBody,
  TrailEvent,
  TrailPhase,
  TrailStepKey,
} from "./types";

/** Client-side cap for a full RAG round-trip against the local model. */
const CHAT_FETCH_TIMEOUT_MS = 180_000;

/** Turns kept when replaying the thread back to the server. */
const MAX_THREAD_MESSAGES = 12;

const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/** Which trail step a `status` event's stage names, if we model it. */
const stepKeyFor = (stage: string | undefined): TrailStepKey | null => {
  const named = stage?.trim();
  switch (named) {
    case "search":
    case "read":
    case "figures":
    case "write":
      return named;
    default:
      return null;
  }
};

/** The phase a step belongs to. `read` and `figures` share one phase: they are
 *  both the retrieval half of the answer, and splitting them would make the
 *  trail show a phase that the engine never announces on its own. */
const PHASE_FOR_KEY: Record<TrailStepKey, TrailPhase> = {
  search: "searching",
  read: "reading",
  figures: "reading",
  write: "writing",
};

const PHASE_ORDER: TrailPhase[] = ["searching", "reading", "writing", "settled"];

/** Never rewinds: a late `status` event naming an earlier step is ignored, so
 *  the trail cannot flicker backwards mid-stream. */
const advancePhase = (current: TrailPhase, next: TrailPhase): TrailPhase =>
  PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(current) ? next : current;

type SseEvent = { event: string; data: string };

/** Splits an SSE body into `{ event, data }` records. Tolerates a final block
 *  with no trailing blank line, which a stream closed mid-flush will have. */
async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) {
        yield parsed;
      }
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) {
    yield tail;
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataParts: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).trimStart());
    }
  }
  const data = dataParts.join("\n");
  return data ? { event, data } : null;
}

const parseJson = <T,>(data: string): T | null => {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
};

const emptyAssistant = (id: string): AssistantMessage => ({
  id,
  role: "assistant",
  content: "",
  directAnswer: "",
  citations: [],
  figures: [],
  exceptions: [],
  grounding: "none",
  notCovered: false,
  retrievalSummary: null,
  streaming: true,
  phase: "searching",
  trailEvents: [],
});

/** Flattens settled turns into the shape the API accepts as prior context. */
const toApiTurns = (messages: ChatMessage[]): ChatApiTurn[] => {
  const turns: ChatApiTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ role: "user", content: message.content });
      continue;
    }
    // An in-flight turn has no settled prose yet; replaying it would send a
    // half-streamed answer back as history.
    if (message.streaming) {
      continue;
    }
    const body = [message.directAnswer.trim(), message.content.trim()]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (body) {
      turns.push({ role: "assistant", content: body });
    } else if (message.error?.trim()) {
      turns.push({ role: "assistant", content: `[Error] ${message.error.trim()}` });
    }
  }
  return turns.slice(-MAX_THREAD_MESSAGES);
};

export type UseChat = ReturnType<typeof useChat>;

/**
 * All chat state and the SSE conversation with the API.
 *
 * The stream contract is `text` / `status` / `usage` / `done` / `error`. Every
 * event except `text` and `done` is treated as optional, so a stream that
 * carries only those two still produces a complete answer: the trail falls
 * back to phases derived from what did arrive.
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [visualFirst, setVisualFirst] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const streamBufferRef = useRef("");
  const streamingIdRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const patchStreaming = useCallback(
    (id: string, patch: (message: AssistantMessage) => AssistantMessage) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.role === "assistant" && message.id === id ? patch(message) : message
        )
      );
    },
    []
  );

  /** Coalesces streamed text into one render per frame. */
  const flushStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    const id = streamingIdRef.current;
    if (!id) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const text = streamBufferRef.current;
      patchStreaming(id, (message) => ({ ...message, content: text }));
    });
  }, [patchStreaming]);

  const resetStream = useCallback(() => {
    streamBufferRef.current = "";
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startNewChat = useCallback(() => {
    cancelInFlight();
    resetStream();
    streamingIdRef.current = null;
    setMessages([]);
    setInput("");
    setHistory([]);
    setBusy(false);
  }, [cancelInFlight, resetStream]);

  const stop = useCallback(() => {
    cancelInFlight();
    resetStream();
    const id = streamingIdRef.current;
    streamingIdRef.current = null;
    if (id) {
      patchStreaming(id, (message) => ({ ...message, streaming: false }));
    }
    setBusy(false);
  }, [cancelInFlight, patchStreaming, resetStream]);

  const sendQuestion = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) {
        return;
      }

      const assistantId = uid();
      streamingIdRef.current = assistantId;
      resetStream();
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", content: question },
        emptyAssistant(assistantId),
      ]);
      setInput("");
      setHistory((prev) => [...prev, question]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), CHAT_FETCH_TIMEOUT_MS);

      try {
        const response = await fetch("/api/webapi/chat/ollama", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...toApiTurns(messages), { role: "user", content: question }],
            stream: true,
            visualFirst,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = parseJson<{ error?: string }>(
            await response.text().catch(() => "")
          );
          const message = body?.error ?? `Request failed (${response.status})`;
          resetStream();
          patchStreaming(assistantId, (prev) => ({
            ...prev,
            streaming: false,
            error: message,
          }));
          return;
        }

        if (!response.body) {
          resetStream();
          patchStreaming(assistantId, (prev) => ({
            ...prev,
            streaming: false,
            error: "No response stream from server.",
          }));
          return;
        }

        let settled = false;

        for await (const { event, data } of readSse(response)) {
          if (event === "text") {
            const chunk = parseJson<{ text?: string }>(data);
            if (chunk?.text) {
              streamBufferRef.current += chunk.text;
              // The first token means the engine is writing, whatever the
              // last `status` event said.
              patchStreaming(assistantId, (prev) => ({
                ...prev,
                phase: advancePhase(prev.phase, "writing"),
              }));
              flushStream();
            }
            continue;
          }

          if (event === "status") {
            const status = parseJson<StreamStatusChunk>(data);
            if (!status) {
              continue;
            }
            patchStreaming(assistantId, (prev) => applyStatus(prev, status));
            continue;
          }

          // `usage` carries token and latency counters, plus the retrieval
          // numbers a `done` without a summary cannot supply. Token counts are
          // not rendered; the retrieval counters are.
          if (event === "usage") {
            const usage = parseJson<StreamUsageBody>(data);
            if (usage) {
              patchStreaming(assistantId, (prev) => applyUsage(prev, usage));
            }
            continue;
          }

          if (event === "done") {
            settled = true;
            const body = parseJson<StreamDoneBody>(data);
            resetStream();
            patchStreaming(assistantId, (prev) => applyDone(prev, body));
            continue;
          }

          if (event === "error") {
            settled = true;
            const body = parseJson<{ error?: string }>(data);
            resetStream();
            patchStreaming(assistantId, (prev) => ({
              ...prev,
              streaming: false,
              phase: "settled",
              error: body?.error ?? "Request failed.",
              content: prev.content || streamBufferRef.current,
            }));
          }
        }

        if (!settled) {
          resetStream();
          patchStreaming(assistantId, (prev) => ({
            ...prev,
            streaming: false,
            phase: "settled",
            content: prev.content.trim() ? prev.content : streamBufferRef.current,
            error: prev.error ?? "Incomplete response (no done event).",
          }));
        }
      } catch (error) {
        resetStream();
        const message =
          error instanceof DOMException && error.name === "AbortError"
            ? "Request stopped. Check that Ollama is running, then try again."
            : error instanceof Error
              ? error.message
              : "Network error.";
        patchStreaming(assistantId, (prev) => ({
          ...prev,
          streaming: false,
          phase: "settled",
          error: message,
        }));
      } finally {
        clearTimeout(timeoutId);
        abortRef.current = null;
        streamingIdRef.current = null;
        setBusy(false);
      }
    },
    [
      busy,
      messages,
      patchStreaming,
      resetStream,
      flushStream,
      visualFirst,
    ]
  );

  useEffect(() => cancelInFlight, [cancelInFlight]);

  // Both derivations below are a single reverse scan (or a single filter) over
  // a short transcript. Left un-memoized on purpose: the React Compiler already
  // memoizes them, and hand-wrapping them only fights it.

  /** True when the newest question repeats the one before it. */
  const duplicateQuestion = (() => {
    const questions = messages
      .filter((message): message is Extract<ChatMessage, { role: "user" }> =>
        message.role === "user"
      )
      .map((message) => message.content.trim());
    const last = questions.at(-1);
    const previous = questions.at(-2);
    return Boolean(last && previous && last === previous);
  })();

  return {
    messages,
    input,
    busy,
    visualFirst,
    history,
    duplicateQuestion,
    setInput,
    setVisualFirst,
    sendQuestion,
    startNewChat,
    stop,
  };
}

/** Folds one `status` event into the message's trail. */
const applyStatus = (message: AssistantMessage, status: StreamStatusChunk): AssistantMessage => {
  const key = stepKeyFor(status.stage);
  const label = status.label;
  if (!label) {
    return message;
  }
  const event: TrailEvent = {
    id: uid(),
    key,
    label,
    detail: status.detail,
  };
  return {
    ...message,
    trailEvents: [...message.trailEvents, event],
    phase: key ? advancePhase(message.phase, PHASE_FOR_KEY[key]) : message.phase,
  };
};

/**
 * The grounding verdict, by the server's own rule: a checkable quote is what
 * grounds an answer, so one citation is "partial", two or more is "esr", and
 * none is "none". A diagram is not a citation — it shows a page the answer
 * came from, not a passage of it.
 */
const groundingFor = (citationCount: number): Grounding =>
  citationCount === 0 ? "none" : citationCount >= 2 ? "esr" : "partial";

/**
 * The chapters the answer rests on, from the citations. A citation knows its
 * chapter; a figure's chapter is where the drawing sits, which is weaker
 * evidence and so is not counted here.
 */
const citedChapters = (citations: SourceCitation[]): string[] => [
  ...new Set(citations.map((c) => c.chapter).filter((c): c is string => Boolean(c))),
];

/**
 * Folds the `usage` event in as a retrieval summary the trail can render.
 *
 * A `done` without a summary leaves the trail with nothing but the stream to
 * describe itself from. The `usage` counters are the engine's own retrieval
 * numbers, so they are better than nothing; the fields the counters cannot
 * supply stay empty rather than guessed. A summary the engine already sent
 * always wins, whichever order the two arrive in.
 */
const applyUsage = (message: AssistantMessage, body: StreamUsageBody): AssistantMessage => {
  const usage = body.usage;
  const count = (value: number | undefined) => (typeof value === "number" ? value : null);
  const candidates = count(usage?.retrieval_candidates);
  const confidence = count(usage?.retrieval_confidence);
  if (message.retrievalSummary || (candidates === null && confidence === null)) {
    return message;
  }
  return {
    ...message,
    retrievalSummary: {
      totalCandidates: candidates ?? 0,
      matchedChunks: 0,
      confidence: confidence ?? 0,
      coverage: 0,
      notCovered: false,
      intent: "",
      chapters: [],
      docs: [],
      latencyMs: count(usage?.retrieval_latency_ms) ?? 0,
    },
  };
};

/**
 * Fills the gaps in a summary built from `usage` once the citations land: the
 * summary arrives before `done`, so it knows the candidate count and the
 * confidence but not which sections were read. Called only when the engine
 * sent no summary of its own.
 */
const settleRetrievalSummary = (
  summary: RetrievalSummary | null,
  citations: SourceCitation[]
): RetrievalSummary | null =>
  summary
    ? { ...summary, matchedChunks: citations.length, chapters: citedChapters(citations) }
    : null;

/** Folds the `done` event over the streamed message. */
const applyDone = (
  message: AssistantMessage,
  body: StreamDoneBody | null
): AssistantMessage => {
  const done = body?.message;
  const text = done?.text ?? message.content;
  const citations = done?.citations ?? message.citations;
  const figures = done?.figures ?? message.figures;
  // Nothing checkable came back means nothing grounds the answer, whether or not
  // the engine said so: a figure can illustrate a page the answer never quoted.
  const notCovered = done?.notCovered ?? citations.length === 0;
  const retrievalSummary = done?.retrievalSummary ?? settleRetrievalSummary(message.retrievalSummary, citations);

  return {
    ...message,
    // A `done` with no text at all still ends the turn; the empty answer is
    // rendered as the "not covered" state rather than an empty bubble.
    content: text,
    directAnswer: done?.directAnswer ?? message.directAnswer,
    citations,
    figures,
    exceptions: done?.exceptions ?? message.exceptions,
    // The server's verdict when it sends one; otherwise the same rule it applies.
    grounding: done?.grounding ?? groundingFor(citations.length),
    notCovered,
    retrievalSummary,
    streaming: false,
    phase: "settled",
  };
};
