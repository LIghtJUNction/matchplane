import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { isMountedPlatformPath } from "../../../src/platform-mount";
import { readActivePlatformManifest } from "../../../src/platform-manifest";
import { authenticatePlatformRequest } from "../../../src/platform-request-auth";
import { isActivePlatformPathVisible } from "../../../src/platform-visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves a single-segment mounted platform manifest for backwards-compatible URLs. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ platformPath: string }> },
): Promise<Response> {
  const { platformPath } = await context.params;
  if (!/^[a-z0-9-]{1,62}$/.test(platformPath)) {
    return NextResponse.json({ error: "invalid platform path" }, { status: 400 });
  }
  const mountedPath = `/${platformPath}`;
  if (!(await isMountedPlatformPath(mountedPath))) {
    return NextResponse.json({ error: "platform is not active" }, { status: 404 });
  }
  const actor = await authenticatePlatformRequest(_request);
  const viewer = actor
    ? { authUserId: actor.access === "session" ? actor.subject : null, organizationId: actor.organizationId }
    : undefined;
  if (!(await isActivePlatformPathVisible(mountedPath, viewer))) {
    return NextResponse.json({ error: "platform manifest is not available" }, { status: 404 });
  }
  const registeredManifest = await readActivePlatformManifest(mountedPath);
  if (registeredManifest) {
    return new Response(registeredManifest, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (process.env.MATCHPLANE_ENVIRONMENT === "production") {
    return NextResponse.json({ error: "platform manifest is not available" }, { status: 404 });
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
