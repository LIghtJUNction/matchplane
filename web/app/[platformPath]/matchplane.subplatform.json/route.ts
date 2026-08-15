import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Serves the immutable manifest for a mounted platform without requiring a static export. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ platformPath: string }> },
): Promise<Response> {
  const { platformPath } = await context.params;
  if (!/^[a-z0-9-]{1,62}$/.test(platformPath)) {
    return NextResponse.json({ error: "invalid platform path" }, { status: 400 });
  }
  try {
    const manifest = await readFile(
      path.join(process.cwd(), "public", platformPath, "matchplane.subplatform.json"),
      "utf8",
    );
    return new Response(manifest, {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "platform manifest not found" }, { status: 404 });
  }
}
