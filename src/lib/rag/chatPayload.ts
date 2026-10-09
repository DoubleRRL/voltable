import { z } from "zod";

import { getAppConfig } from "@/lib/env";
import {
  answerQuestion,
  answerQuestionOutcome,
  type AnswerOutcome,
  type AnswerSink,
} from "@/lib/rag/pipeline";
import type {
  ChatAnswer,
  FigureEvidence,
  Grounding,
  SourceCitation,
  StoredException,
} from "@/lib/rag/types";

type ChatMessageRole = "system" | "user" | "assistant" | "function" | "tool";

type ChatMessageContentText = {
  type: "text";
  text: string;
};

type ChatMessageContent = string | ChatMessageContentText[];

export type RawChatMessage = {
  role: ChatMessageRole;
  content: ChatMessageContent;
};

export type RawChatPayload = {
  question?: string;
  messages?: RawChatMessage[];
  model?: string;
  provider?: string;
  stream?: boolean;
};

export type NormalizedChatPayload = {
  question: string;
  model: string;
  provider: string;
  stream: boolean;
  visualFirst: boolean;
  conversationPrefix: string;
};

type ParseSuccess = {
  ok: true;
  value: NormalizedChatPayload;
};

type ParseFailure = {
  ok: false;
  error: string;
};

type ParseResult = ParseSuccess | ParseFailure;

const messageContentTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "function", "tool"]),
  content: z.union([z.string(), z.array(messageContentTextSchema)]),
});

const payloadSchema = z.object({
  question: z.string().trim().min(2).max(2000).optional(),
  messages: z.array(messageSchema).optional(),
  model: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  stream: z.boolean().optional(),
  visualFirst: z.boolean().optional(),
});

const toTextFromContent = (content: ChatMessageContent) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join(" ");

const extractQuestion = (payload: RawChatPayload) => {
  if (payload.question && payload.question.trim()) {
    return payload.question.trim();
  }

  if (!Array.isArray(payload.messages)) {
    return null;
  }

  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    const text = toTextFromContent(message.content).trim();
    if (text) {
      return text;
    }
  }

  return null;
};

const buildConversationPrefix = (messages: z.infer<typeof messageSchema>[]): string => {
  let lastUserIdx = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && toTextFromContent(message.content as ChatMessageContent).trim()) {
      lastUserIdx = index;
      break;
    }
  }
  if (lastUserIdx <= 0) {
    return "";
  }

  const lines: string[] = [];
  const maxChars = 4000;
  for (let i = 0; i < lastUserIdx; i += 1) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = toTextFromContent(message.content as ChatMessageContent).trim();
    if (!text) {
      continue;
    }
    const line = message.role === "user" ? `User: ${text}` : `Assistant: ${text}`;
    lines.push(line);
    if (lines.join("\n").length > maxChars) {
      lines.pop();
      lines.push("… (earlier thread trimmed)");
      break;
    }
  }
  return lines.join("\n");
};

export const normalizeChatPayload = (raw: unknown): ParseResult => {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "Invalid payload. Provide { question: string } or { messages: [...] } with a user message.",
    };
  }

  const question = extractQuestion(parsed.data);
  if (!question) {
    return {
      ok: false,
      error: "Could not derive a question from the payload.",
    };
  }

  const config = getAppConfig();
  const conversationPrefix =
    Array.isArray(parsed.data.messages) && parsed.data.messages.length > 0
      ? buildConversationPrefix(parsed.data.messages)
      : "";

  return {
    ok: true,
    value: {
      question,
      model: parsed.data.model ?? config.OLLAMA_CHAT_MODEL,
      provider: parsed.data.provider ?? "ollama",
      stream: parsed.data.stream !== false,
      visualFirst: parsed.data.visualFirst === true,
      conversationPrefix,
    },
  };
};

export const askQuestionWithRag = async (
  question: string,
  visualFirst = false,
  conversationPrefix = ""
): Promise<ChatAnswer> => {
  return answerQuestion(question, { visualFirst, conversationPrefix });
};

/**
 * Same question, answered with progress reported as it happens.
 *
 * With a `sink` the model is streamed, so `text` arrives as it is produced; with
 * no sink this is the one-shot path. Either way `usage` carries the counts the
 * model server reported, or null when it reported none.
 */
export const askQuestionWithRagStreaming = (
  question: string,
  options: {
    visualFirst?: boolean;
    conversationPrefix?: string;
    sink?: AnswerSink;
    signal?: AbortSignal;
  } = {}
): Promise<AnswerOutcome> => {
  return answerQuestionOutcome(question, options);
};

export type StreamTextChunk = {
  text: string;
};

/**
 * One step of the engine's own account of what it is doing.
 *
 * `stage` names the step so the client can group it, `label` is what a reader
 * sees, `detail` carries the numbers behind it. Nothing here is optional except
 * `detail`: an engine step with no label is a step nobody can read.
 */
export type StreamStatusChunk = {
  stage: "search" | "read" | "figures" | "write";
  label: string;
  detail?: string;
};

export type StreamUsageChunk = {
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Wall-clock for the whole exchange, generation included. */
    latency_ms: number;
    /** Wall-clock for retrieval alone, as reported by the engine. */
    retrieval_latency_ms?: number;
    retrieval_candidates?: number;
    retrieval_confidence?: number;
    /**
     * Whether the token counts were measured or are absent. "model" means the
     * model server counted them; "unavailable" means it reported none, and the
     * zeros are zeros rather than an estimate dressed up as a count.
     */
    tokens_source: "model" | "unavailable";
  };
};

export type StreamDoneChunk = {
  message: {
    role: "assistant";
    text: string;
    directAnswer: string;
    citations: SourceCitation[];
    figures: FigureEvidence[];
    exceptions?: StoredException[];
    /** The engine's verdict on support, not one the client has to infer. */
    grounding: Grounding;
    notCovered: boolean;
    retrievalSummary: ChatAnswer["retrievalSummary"];
  };
  provider: string;
  model: string;
  latencyMs: number;
};
