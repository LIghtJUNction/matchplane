import { NextResponse } from "next/server";

import { readActiveDirectChildRoutes } from "../../../../src/platform-child-routes";
import { isMountedPlatformPath } from "../../../../src/platform-mount";
import { authenticatePlatformRequest } from "../../../../src/platform-request-auth";
import { requestSearchParams } from "../../../../src/lib/request-url";
import { isActivePlatformPathVisible } from "../../../../src/platform-visibility";
import { isUuid } from "../../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public, domain-neutral child navigation. The root UI never embeds a catalogue or a
 * vertical name; it only receives active platform nodes from the same tree used by routing.
 */
export async function GET(request: Request): Promise<Response> {
  const path = requestSearchParams(request).get("path")?.trim() || "/";
  if (!(path === "/" || /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path))) {
    return NextResponse.json(
      { error: "invalid platform path" },
      { status: 400 },
    );
  }
  if (!(await isMountedPlatformPath(path))) {
    return NextResponse.json(
      { error: "platform is not active" },
      { status: 404 },
    );
  }

  const actor = await authenticatePlatformRequest(request);
  const viewer = actor
    ? {
        authUserId: actor.access === "session" ? actor.subject : null,
        organizationId: actor.organizationId,
        isRootAdministrator: actor.isRootAdministrator,
      }
    : undefined;
  if (!(await isActivePlatformPathVisible(path, viewer))) {
    return NextResponse.json(
      { error: "platform is not available" },
      { status: 404 },
    );
  }

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(rootTenantId)) {
    return NextResponse.json(
      { children: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const children = await readActiveDirectChildRoutes(
    path,
    rootTenantId,
    viewer,
  );
  return NextResponse.json(
    {
      children: children.map(
        ({
          slug,
          path: childPath,
          displayName,
          description,
          capabilities,
          agentStages,
          agentSkills,
        }) => ({
          slug,
          path: childPath,
          displayName,
          description,
          capabilities,
          agentStages,
          agentSkills,
        }),
      ),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
