import { NextRequest, NextResponse } from "next/server";

import { searchChunkSuggestions } from "@/lib/rag/storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }
  if (q.length > 240) {
    return NextResponse.json({ error: "Query too long." }, { status: 400 });
  }

  try {
    const suggestions = searchChunkSuggestions(q, 8);
    return NextResponse.json({ suggestions });
  } catch {
    return NextResponse.json({ error: "Suggest failed." }, { status: 500 });
  }
}
