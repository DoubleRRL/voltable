import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Emit a self-contained server bundle for the macOS .app wrapper.
   *
   * The wrapper ships node plus this output inside the app bundle and never
   * runs `npm install`, so runtime dependencies have to be traced into
   * `.next/standalone` rather than resolved from node_modules at boot.
   */
  output: process.env.ESR_STANDALONE === "1" ? "standalone" : undefined,

  // The ingest path resolves .venv-mineru/bin/python, which symlinks outside the
  // project root; Turbopack refuses to bundle it. Ingest runs from the repo, not
  // from inside the app bundle, so this only guards the dev/build path.
  outputFileTracingExcludes: {
    "*": [".venv-mineru/**", "data/render-cache/**", ".next/cache/**"],
  },

  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;