import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";

export const runtime = "nodejs";

const MAX_NARRATIVE_LENGTH = 10_000;
const MAX_PATH_LENGTH = 512;

/**
 * Accepts a domain-neutral intent at the current platform node and returns the
 * next platform hops. The route plan is deliberately data-driven: only active
 * registrations from PostgreSQL are delegated to, never a hard-coded vertical.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });

  const input = await parseBody(request);
  const narrative = input.narrative?.trim() ?? "";
  const platformPath = normalizePlatformPath(input.platformPath);
  if (!narrative || narrative.length > MAX_NARRATIVE_LENGTH) {
    return NextResponse.json({ error: "narrative must contain 1..=10000 characters" }, { status: 400 });
  }
  if (!platformPath) {
    return NextResponse.json({ error: "platformPath is invalid" }, { status: 400 });
  }

  const routePlan = await readChildRoutePlan(platformPath);
  const requestId = randomUUID();
  await authDatabase.query(
    `INSERT INTO platform_match_requests
      (id, auth_user_id, platform_path, narrative, route_plan, status)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)`,
    [requestId, session.user.id, platformPath, narrative, JSON.stringify(routePlan), routePlan.length ? "delegated" : "accepted"],
  );

  return NextResponse.json(
    {
      requestId,
      platformPath,
      status: routePlan.length ? "delegated" : "accepted",
      routePlan,
    },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

interface MatchRequest {
  narrative?: string;
  platformPath?: string;
}

interface RouteHop {
  slug: string;
  path: string;
  displayName: string;
  description: string;
  tenantId: string;
  domainId: string;
  depth: number;
}

async function parseBody(request: Request): Promise<MatchRequest> {
  try {
    const body = (await request.json()) as MatchRequest;
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

async function readChildRoutePlan(platformPath: string): Promise<RouteHop[]> {
  const currentSlug = platformPath === "/" ? null : platformPath.split("/").filter(Boolean).at(-1) ?? null;
  const result = await authDatabase.query(
    `WITH RECURSIVE current_nodes AS (
       SELECT o.id, o."parentOrganizationId", 0::int AS depth
         FROM "organization" o
        WHERE ($1::text IS NULL AND o."parentOrganizationId" IS NULL)
           OR ($1::text IS NOT NULL AND o.slug = $1::text)
       UNION ALL
       SELECT child.id, child."parentOrganizationId", current_nodes.depth + 1
         FROM "organization" child
         JOIN current_nodes ON child."parentOrganizationId" = current_nodes.id
        WHERE current_nodes.depth < 64
     )
     SELECT r.slug,
            COALESCE(r.manifest ->> 'displayName', r.slug) AS "displayName",
            COALESCE(r.manifest ->> 'description', '') AS description,
            r.tenant_id AS "tenantId",
            r.domain_id AS "domainId",
            current_nodes.depth + 1 AS depth,
            COALESCE(r.manifest -> 'routes' ->> 0, '/' || r.slug) AS path
       FROM subplatform_registrations r
       JOIN "organization" o ON o.slug = r.slug
       JOIN current_nodes ON current_nodes.id = o."parentOrganizationId"
      WHERE r.state IN ('ready', 'active')
      ORDER BY current_nodes.depth ASC, r.slug ASC`,
    [currentSlug],
  );
  return result.rows.map((row) => ({
    slug: String(row.slug),
    path: safeRoutePath(String(row.path), String(row.slug)),
    displayName: String(row.displayName),
    description: String(row.description),
    tenantId: String(row.tenantId),
    domainId: String(row.domainId),
    depth: Number(row.depth),
  }));
}

function normalizePlatformPath(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) return null;
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  if (normalized === "/") return normalized;
  return /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(normalized) ? normalized : null;
}

function safeRoutePath(value: string, fallbackSlug: string): string {
  return /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value) ? value : `/${fallbackSlug}`;
}
