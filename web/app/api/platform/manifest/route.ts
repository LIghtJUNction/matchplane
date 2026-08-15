import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { isMountedPlatformPath } from "../../../../src/platform-mount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manifest endpoint for recursive paths (Next cannot place a catch-all before a suffix). */
export async function GET(request: Request): Promise<Response> {
  const requestedPath = new URL(request.url).searchParams.get("path") ?? "";
  if (!/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(requestedPath)) {
    return NextResponse.json({ error: "invalid platform path" }, { status: 400 });
  }
  if (!(await isMountedPlatformPath(requestedPath))) {
    return NextResponse.json({ error: "platform is not active" }, { status: 404 });
  }
  const segments = requestedPath.slice(1).split("/");
  try {
    const manifest = await readFile(
      path.join(process.cwd(), "public", ...segments, "matchplane.subplatform.json"),
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
