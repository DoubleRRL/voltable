import { NextResponse } from "next/server";

import { getDb } from "@/lib/rag/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe for the macOS launcher.
 *
 * The app wrapper spawns the server and waits on this before showing a window,
 * so it must fail loudly when the index is missing or empty — otherwise the
 * launcher opens a window onto a UI that will silently return no answers.
 */
export function GET() {
  try {
    const db = getDb();
    const chunks = db.prepare("SELECT COUNT(1) AS c FROM chunks").get() as { c: number };
    const assets = db.prepare("SELECT COUNT(1) AS c FROM visual_assets").get() as { c: number };

    if (chunks.c === 0) {
      return NextResponse.json(
        { ok: false, error: "index is empty", chunks: 0, assets: assets.c },
        { status: 503 }
      );
    }

    return NextResponse.json({ ok: true, chunks: chunks.c, assets: assets.c });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "health check failed",
      },
      { status: 503 }
    );
  }
}