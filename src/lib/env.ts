import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

const intFromEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const floatFromEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Resolve ESR PDF path: env path, then common monorepo-root filenames.
 *
 * The PDF sits above the project root, so every path here is outside it. The
 * `turbopackIgnore` comments mark the probes as runtime-only: without them
 * Turbopack tries to trace these paths into the output files and warns that the
 * whole project was traced. Only ingest reads this value.
 */
/**
 * Locate the manual directory.
 *
 * Only ingest resolves manuals, so only ingest pays for the search. The app
 * bundle ships an index and evidence images, never the source PDFs.
 */
export const resolveManualsDir = (configured: string): string => {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(/* turbopackIgnore: true */ cwd, configured.trim()),
    path.resolve(/* turbopackIgnore: true */ cwd, ".."),
    path.resolve(/* turbopackIgnore: true */ cwd, "manuals"),
  ];
  for (const dir of candidates) {
    try {
      if (
        fs.existsSync(/* turbopackIgnore: true */ dir) &&
        fs.statSync(/* turbopackIgnore: true */ dir).isDirectory()
      ) {
        return dir;
      }
    } catch {
      /* keep searching */
    }
  }
  return candidates[0];
};

const schema = z.object({
  NODE_ENV: z
    .string()
    .default("development")
    .transform((value) => value.toLowerCase()),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("qwen2.5:latest"),
  OPENAI_TEMPERATURE: z
    .string()
    .optional()
    .transform((value) => floatFromEnv(value, 0.15)),
  /**
   * Total budget for one model call.
   *
   * Was 12000ms, which was below the time this machine actually needs to
   * answer a retrieval-grounded prompt (~40s for qwen2.5:latest with a full
   * context). Every generation silently timed out and fell back to the
   * extractive answer, so the model path was never exercised and the eval
   * reported modelPathRate 0.00 without anyone noticing why.
   */
  REQUEST_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => intFromEnv(value, 90000)),
  /**
   * Directory holding the source manual PDFs. Ingest reads them; the running
   * app never does, which is what keeps a 200 MB corpus out of the bundle.
   */
  MANUALS_DIR: z.string().default("..").transform(resolveManualsDir),
  /** SQLite index over every ingested manual. */
  MANUALS_DB_PATH: z.string().default("./data/manuals.sqlite"),
  /** MinerU layout JSON, one per manual, written by scripts/render/parse.sh. */
  MANUALS_LAYOUT_DIR: z.string().default("./data/mineru"),
  /**
   * Python interpreter for the render/OCR worker. Only `scripts/ingest-esr.ts`
   * spawns it; the web app never runs it.
   *
   * The default is `path.join(...)` over literal segments, which Turbopack
   * reads as a directory asset reference and resolves at build time. In a venv
   * `bin/python` is a symlink into the interpreter's prefix, outside the
   * project root, and the build fails with `Symlink ... is invalid, it points
   * out of the filesystem root`. The magic comment has to sit on the call's
   * first argument, where Turbopack reads it (as Next itself does for its own
   * `path.join` calls), which leaves the expression as a plain runtime join.
   */
  ESR_PYTHON: z
    .string()
    .optional()
    .transform(
      (value) =>
        value || path.join(/* turbopackIgnore: true */ process.cwd(), ".venv-mineru", "bin", "python")
    ),
  /**
   * Server routes that hand out evidence for a cited location. A citation has
   * to open something, and the whole manual is not in the bundle, so the route
   * resolves against whatever evidence was generated for that page.
   */
  EVIDENCE_DIR: z.string().default("./public/evidence"),
  RETRIEVAL_TOP_K: z
    .string()
    .optional()
    .transform((value) => intFromEnv(value, 4)),
  RETRIEVAL_CANDIDATES: z
    .string()
    .optional()
    .transform((value) => intFromEnv(value, 16)),
  EMBEDDING_CACHE_TTL_SECONDS: z
    .string()
    .optional()
    .transform((value) => intFromEnv(value, 3600)),
  MAX_OUTPUT_TOKENS: z
    .string()
    .optional()
    .transform((value) => intFromEnv(value, 320)),
  /** When true, skip LLM and use extractive fallback only (faster, fully grounded). */
  EXTRACTIVE_ANSWER: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1" || value === "yes"),
});

export type AppConfig = z.output<typeof schema>;

let cachedConfig: AppConfig | null = null;

export const getAppConfig = (): AppConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = schema.parse(process.env);
  cachedConfig = parsed;

  return parsed;
};

