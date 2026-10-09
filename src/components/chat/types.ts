import type {
  ChatAnswer,
  FigureEvidence,
  Grounding,
  SourceCitation,
  StoredException,
} from "@/lib/rag/types";

/** Retrieval telemetry the API reports on `done`. */
export type RetrievalSummary = ChatAnswer["retrievalSummary"];

/** One transcript entry authored by the planner. */
export type UserMessage = {
  id: string;
  role: "user";
  content: string;
};

/**
 * How far retrieval has got. Drives which thinking steps are complete, which
 * is active, and which have not started yet. Monotonic: a phase only ever
 * moves forward, so a late `status` event can never rewind the trail.
 */
export type TrailPhase = "searching" | "reading" | "writing" | "settled";

/**
 * A `status` event from the SSE stream: a stage naming which step the engine
 * is on, plus the human label and the supporting detail it reports for it.
 *
 * Every field is optional because the whole event is optional: a stream that
 * narrates nothing still has to produce an answer, and the trail falls back to
 * phases derived from what did arrive. A stage this client does not model is
 * kept as an unkeyed step so its label still shows.
 */
export type StreamStatusChunk = {
  stage?: string;
  label?: string;
  detail?: string;
};

/** One `status` event after parsing, normalised onto a known step key. */
export type TrailEvent = {
  id: string;
  /** `search` | `read` | `figures` | `write`, or `null` when the engine sent
   *  a step this client does not model (kept, so the label still shows). */
  key: TrailStepKey | null;
  label: string;
  detail?: string;
};

/** The retrieval steps the trail renders. */
export type TrailStepKey = "search" | "read" | "figures" | "write";

/** One transcript entry authored by the assistant. */
export type AssistantMessage = {
  id: string;
  role: "assistant";
  /** Full answer prose, streamed in `text` events. */
  content: string;
  /** The one-line answer shown above the prose. */
  directAnswer: string;
  citations: SourceCitation[];
  figures: FigureEvidence[];
  exceptions: StoredException[];
  grounding: Grounding;
  notCovered: boolean;
  retrievalSummary: RetrievalSummary | null;
  /** True while the stream is open; false once `done` or `error` settles it. */
  streaming: boolean;
  /** Set by the `error` event, or by a stream that ended without `done`. */
  error?: string;
  phase: TrailPhase;
  /** `status` events, oldest first. */
  trailEvents: TrailEvent[];
};

export type ChatMessage = UserMessage | AssistantMessage;

/** Sent-message history for the composer's ArrowUp recall. */
export type ChatApiTurn = { role: "user" | "assistant"; content: string };

/** Body of the `done` event. Mirrors `StreamDoneChunk` plus the grounding
 *  fields `ChatAnswer` carries; every field beyond `text` is treated as
 *  optional so a `done` that only carries text still renders an answer. */
export type StreamDoneBody = {
  message?: {
    text?: string;
    directAnswer?: string;
    citations?: SourceCitation[];
    figures?: FigureEvidence[];
    exceptions?: StoredException[];
    grounding?: Grounding;
    notCovered?: boolean;
    retrievalSummary?: RetrievalSummary | null;
  };
  usage?: unknown;
};

/**
 * The retrieval counters on the `usage` event, nested under `usage` as the
 * event sends them. They are the only retrieval numbers a stream with no
 * `retrievalSummary` can show, so they fill that gap; the token counts are not
 * rendered.
 */
export type StreamUsageBody = {
  usage?: {
    retrieval_candidates?: number;
    retrieval_confidence?: number;
    retrieval_latency_ms?: number;
  };
};

export type { FigureEvidence, Grounding, SourceCitation, StoredException };
