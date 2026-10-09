import { getAppConfig, type AppConfig } from "@/lib/env";

export type ModelResponse = {
  answer?: string;
  directAnswer?: string;
  citations?: Array<{ chunkIndex?: number; reason?: string; type?: string }>;
  figures?: Array<{ chunkIndex?: number }>;
};

/** Token counts Ollama reports on the last chunk of a response. */
export type OllamaUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type ModelResult = {
  response: ModelResponse;
  /** Null when Ollama reported no counts, which is not the same as zero. */
  usage: OllamaUsage | null;
};

type OllamaChatPayload = {
  model: string;
  temperature: number;
  stream: boolean;
  messages: Array<{ role: "system" | "user"; content: string }>;
  format?: "json";
  options?: {
    num_predict: number;
  };
};

type OllamaResponseChunk = {
  message?: {
    content?: string;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

export type StreamOllamaOptions = {
  /**
   * Each decoded fragment of the model's `answer` string, in arrival order.
   * Awaited, so a slow consumer applies backpressure to the read loop.
   */
  onAnswerText?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
};

const chatInit = (
  config: AppConfig,
  prompt: string,
  stream: boolean,
  signal?: AbortSignal
): RequestInit => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  signal,
  body: JSON.stringify({
    model: config.OLLAMA_CHAT_MODEL,
    stream,
    temperature: config.OPENAI_TEMPERATURE,
    format: "json",
    options: {
      num_predict: config.MAX_OUTPUT_TOKENS,
    },
    messages: [
      { role: "system", content: "You are a retrieval-grounded ESR assistant." },
      { role: "user", content: prompt },
    ],
  } satisfies OllamaChatPayload),
});

const extractJsonFromText = (text: string) => {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("No JSON payload found in model output");
  }

  return JSON.parse(trimmed.slice(start, end + 1));
};

const readUsage = (payload: OllamaResponseChunk): OllamaUsage | null => {
  const promptTokens =
    typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : null;
  const completionTokens = typeof payload.eval_count === "number" ? payload.eval_count : null;
  if (promptTokens === null && completionTokens === null) {
    return null;
  }
  return { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 };
};

/** The key whose value is the prose the client renders. Mirrors `answerPrompt`. */
const PROSE_KEY = "answer";

const UNESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

type AnswerScanner = {
  /** Feeds raw model output, returns the prose decoded since the last call. */
  push: (raw: string) => string;
};

/**
 * Reads one top-level string value out of a JSON document that is still arriving.
 *
 * The model is constrained to JSON, but the prose is a single string value
 * thousands of characters long, so it has to be decoded character by character —
 * escapes included — while the rest of the document is still incomplete. Only
 * the value of `PROSE_KEY` at depth one is decoded; everything else is tracked
 * for structure alone.
 */
const createAnswerScanner = (): AnswerScanner => {
  const containers: string[] = [];
  let currentKey: string | null = null;
  let pendingKey = "";
  let keyBuffer = "";
  let readingKey = true;
  let inString = false;
  let capturing = false;
  let escape = "";
  let unicodeLeft = 0;

  const push = (raw: string): string => {
    let decoded = "";
    for (const char of raw) {
      if (inString) {
        if (unicodeLeft > 0) {
          escape += char;
          unicodeLeft -= 1;
          if (unicodeLeft === 0) {
            const code = Number.parseInt(escape.slice(2), 16);
            escape = "";
            if (capturing && Number.isFinite(code)) {
              decoded += String.fromCharCode(code);
            }
          }
          continue;
        }
        if (escape) {
          if (char === "u") {
            escape += char;
            unicodeLeft = 4;
            continue;
          }
          const resolved = UNESCAPES[char] ?? char;
          escape = "";
          if (capturing) {
            decoded += resolved;
          } else {
            keyBuffer += resolved;
          }
          continue;
        }
        if (char === "\\") {
          escape = "\\";
          continue;
        }
        if (char === '"') {
          inString = false;
          if (!capturing) {
            pendingKey = keyBuffer;
            keyBuffer = "";
          }
          capturing = false;
          continue;
        }
        if (capturing) {
          decoded += char;
        } else {
          keyBuffer += char;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        keyBuffer = "";
        capturing = containers.length === 1 && !readingKey && currentKey === PROSE_KEY;
        continue;
      }
      if (char === "{") {
        containers.push(char);
        if (containers.length === 1) {
          readingKey = true;
        }
        continue;
      }
      if (char === "[") {
        containers.push(char);
        continue;
      }
      if (char === "}" || char === "]") {
        containers.pop();
        continue;
      }
      if (char === ":") {
        if (containers.length === 1) {
          currentKey = pendingKey;
          readingKey = false;
        }
        continue;
      }
      if (char === ",") {
        if (containers.length === 1) {
          currentKey = null;
          readingKey = true;
        }
      }
    }
    return decoded;
  };

  return { push };
};

/**
 * Streams a chat completion and hands the answer prose over as it is decoded.
 *
 * Ollama answers in newline-delimited JSON, one object per token-ish slice, and
 * the `done` object carries the real `prompt_eval_count` / `eval_count`. The
 * timeout is on the gap between chunks, not on the whole completion: a 320-token
 * answer on a cold model legitimately takes longer than a single request budget,
 * and cutting it off would truncate exactly the stream being asked for.
 */
export const streamOllama = async (
  prompt: string,
  options: StreamOllamaOptions = {}
): Promise<ModelResult> => {
  const config = getAppConfig();
  const response = await fetch(
    `${config.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`,
    chatInit(config, prompt, true, options.signal)
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama chat error: ${response.status} ${response.statusText}: ${body}`);
  }
  if (!response.body) {
    throw new Error("Ollama returned no response body to stream.");
  }

  const scanner = createAnswerScanner();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let raw = "";
  let usage: OllamaUsage | null = null;
  let completed = false;

  const handleLine = async (line: string) => {
    if (!line) {
      return;
    }
    let chunk: OllamaResponseChunk;
    try {
      chunk = JSON.parse(line) as OllamaResponseChunk;
    } catch {
      return;
    }
    if (chunk.error) {
      throw new Error(`Ollama stream error: ${chunk.error}`);
    }
    const content = chunk.message?.content ?? "";
    if (content) {
      raw += content;
      const delta = scanner.push(content);
      if (delta && options.onAnswerText) {
        await options.onAnswerText(delta);
      }
    }
    if (chunk.done) {
      usage = readUsage(chunk) ?? usage;
      completed = true;
    }
  };

  try {
    for (;;) {
      const { done, value } = await withTimeout(
        reader.read(),
        config.REQUEST_TIMEOUT_MS,
        "Ollama stopped sending tokens"
      );
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        await handleLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    await handleLine(buffer.trim());
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }

  if (!completed) {
    throw new Error("Ollama closed the stream before the answer finished.");
  }

  return { response: extractJsonFromText(raw) as ModelResponse, usage };
};

/**
 * One-shot completion, for callers that want the whole answer and nothing else.
 * `streamOllama` is the streaming half of the same transport; this one exists so
 * the non-streaming path keeps its total-duration budget.
 */
export const askOllama = async (prompt: string): Promise<ModelResult> => {
  const config = getAppConfig();
  const response = await withTimeout(
    fetch(
      `${config.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`,
      chatInit(config, prompt, false)
    ),
    config.REQUEST_TIMEOUT_MS,
    "ollama chat timeout"
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama chat error: ${response.status} ${response.statusText}: ${body}`);
  }

  const payload = (await response.json()) as OllamaResponseChunk;
  const raw = payload.message?.content ?? "";
  return {
    response: extractJsonFromText(raw) as ModelResponse,
    usage: readUsage(payload),
  };
};