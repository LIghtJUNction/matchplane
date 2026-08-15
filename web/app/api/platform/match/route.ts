import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { decidePlatformRoutes } from "../../../../src/platform-router";

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

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  const candidates = rootTenantId && isUuid(rootTenantId)
    ? await readChildRoutePlan(platformPath, rootTenantId)
    : [];
  const routing = await decidePlatformRoutes({
    platformPath,
    narrative,
    candidates: candidates.map(({ tenantId: _tenantId, domainId: _domainId, ...candidate }) => candidate),
  });
  const candidateBySlug = new Map(candidates.map((candidate) => [candidate.slug, candidate]));
  const routePlan = routing.selectedSlugs
    .map((slug) => candidateBySlug.get(slug))
    .filter((candidate): candidate is RouteHop => Boolean(candidate));
  const status = routePlan.length === 0
    ? "accepted"
    : routing.degraded
      ? "degraded"
      : "delegated";
  const requestId = randomUUID();
  await authDatabase.query(
    `INSERT INTO platform_match_requests
      (id, auth_user_id, platform_path, narrative, route_plan, routing_decision, status)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [requestId, session.user.id, platformPath, narrative, JSON.stringify(routePlan), JSON.stringify(routing), status],
  );

  return NextResponse.json(
    {
      requestId,
      platformPath,
      status,
      routePlan,
      routing,
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
  capabilities: string[];
  agentStages: string[];
  agentSkills: string[];
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

async function readChildRoutePlan(platformPath: string, rootTenantId: string): Promise<RouteHop[]> {
  const currentSlug = platformPath === "/" ? null : platformPath.split("/").filter(Boolean).at(-1) ?? null;
  const result = await authDatabase.query(
    `WITH current_node AS (
       SELECT o.id
         FROM "organization" o
        WHERE $1::text IS NOT NULL
          AND o.slug = $1::text
          AND o."tenantId" = $2::text
     )
     SELECT r.slug,
            COALESCE(r.manifest ->> 'displayName', r.slug) AS "displayName",
            COALESCE(r.manifest ->> 'description', '') AS description,
            r.tenant_id AS "tenantId",
            r.domain_id AS "domainId",
            COALESCE(r.manifest -> 'routes' ->> 0, '/' || r.slug) AS path,
            COALESCE(r.manifest -> 'capabilities', '[]'::jsonb) AS capabilities,
            COALESCE(r.manifest -> 'agent' -> 'stages', '[]'::jsonb) AS "agentStages",
            COALESCE(r.manifest -> 'agent' -> 'skills', '[]'::jsonb) AS "agentSkills"
      FROM subplatform_registrations r
      JOIN "organization" o ON o.slug = r.slug AND o."tenantId" = r.tenant_id::text
      LEFT JOIN current_node ON true
      WHERE r.tenant_id = $2::uuid
        AND r.state = 'active'
        AND (($1::text IS NULL AND o."parentOrganizationId" IS NULL)
          OR ($1::text IS NOT NULL AND current_node.id IS NOT NULL
              AND o."parentOrganizationId" = current_node.id::text))
      ORDER BY r.slug ASC`,
    [currentSlug, rootTenantId],
  );
  return result.rows.map((row) => ({
    slug: String(row.slug),
    path: safeRoutePath(String(row.path), String(row.slug)),
    displayName: String(row.displayName),
    description: String(row.description),
    tenantId: String(row.tenantId),
    domainId: String(row.domainId),
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter((item: unknown): item is string => typeof item === "string").slice(0, 64)
      : [],
    agentStages: Array.isArray(row.agentStages)
      ? row.agentStages.filter((item: unknown): item is string => typeof item === "string").slice(0, 8)
      : [],
    agentSkills: Array.isArray(row.agentSkills)
      ? row.agentSkills.filter((item: unknown): item is string => typeof item === "string").slice(0, 32)
      : [],
    depth: 1,
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
