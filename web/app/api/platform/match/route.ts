import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  decidePlatformRoutes,
  isPlatformRouterConfigured,
  type PlatformRouteDecision,
} from "../../../../src/platform-router";
import { expandPlatformRouteTree, type PlatformRouteTrace } from "../../../../src/platform-orchestrator";

export const runtime = "nodejs";

const MAX_NARRATIVE_LENGTH = 10_000;
const MAX_PATH_LENGTH = 512;
const DEFAULT_AI_REQUESTS_PER_HOUR = 120;
const DEFAULT_AI_MAX_STEPS = 8;

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
  // The platform pays for model calls.  Before making one, apply a bounded
  // per-account admission limit so a leaked session cannot create an
  // unbounded provider bill. When a provider is configured, even a degraded
  // attempt counts against the admission budget; otherwise a failing provider
  // could be retried forever while every row was labeled policy_fallback.
  if (candidates.length > 0 && isPlatformRouterConfigured()) {
    const recent = await authDatabase.query(
      `SELECT count(*)::int AS count
        FROM platform_ai_usage
        WHERE auth_user_id = $1
          AND (source = 'ai' OR model IS NOT NULL)
          AND created_at >= clock_timestamp() - interval '1 hour'`,
      [session.user.id],
    );
    const count = Number((recent.rows[0] as { count?: number } | undefined)?.count ?? 0);
    if (count >= configuredAiRequestsPerHour()) {
      return NextResponse.json(
        { error: "平台 AI 撮合额度暂时用尽，请稍后再试。" },
        { status: 429, headers: { "retry-after": "3600", "cache-control": "no-store" } },
      );
    }
  }
  const recursive = await expandPlatformRouteTree({
    platformPath,
    narrative,
    candidates,
    loadChildren: async (childPath) => readChildRoutePlan(childPath, rootTenantId ?? ""),
    decide: ({ platformPath: currentPath, narrative: currentNarrative, candidates: currentCandidates }) =>
      decidePlatformRoutes({
        platformPath: currentPath,
        narrative: currentNarrative,
        candidates: currentCandidates.map(({ tenantId: _tenantId, domainId: _domainId, ...candidate }) => candidate),
      }),
    maxSteps: configuredAiMaxSteps(),
    maxDepth: configuredAiMaxSteps(),
  });
  const routing = summarizeRouting(recursive.trace, recursive.truncated);
  const routePlan = recursive.routePlan;
  const status = routePlan.length === 0
    ? "accepted"
    : routing.degraded
      ? "degraded"
      : "delegated";
  const requestId = randomUUID();
  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO platform_match_requests
        (id, auth_user_id, platform_path, narrative, route_plan, routing_decision, status)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        requestId,
        session.user.id,
        platformPath,
        narrative,
        JSON.stringify(routePlan),
        JSON.stringify({ ...routing, trace: recursive.trace }),
        status,
      ],
    );
    await client.query(
      `INSERT INTO platform_ai_usage
        (id, match_request_id, auth_user_id, platform_path, source, cost_bearer,
         model, max_input_characters, max_output_tokens, prompt_tokens,
         completion_tokens, total_tokens, degraded)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        randomUUID(),
        requestId,
        session.user.id,
        platformPath,
        routing.source,
        routing.costBearer,
        routing.model,
        routing.budget.maxInputCharacters,
        routing.budget.maxOutputTokens,
        routing.usage?.promptTokens ?? null,
        routing.usage?.completionTokens ?? null,
        routing.usage?.totalTokens ?? null,
        routing.degraded,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("platform match request persistence failed", error);
    return NextResponse.json({ error: "平台撮合记录保存失败，请稍后再试。" }, { status: 503 });
  } finally {
    client?.release();
  }

  return NextResponse.json(
    {
      requestId,
      platformPath,
      status,
      routePlan,
      routing,
      routingTrace: recursive.trace,
    },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

function configuredAiRequestsPerHour(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR ?? String(DEFAULT_AI_REQUESTS_PER_HOUR), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(10_000, parsed)) : DEFAULT_AI_REQUESTS_PER_HOUR;
}

function configuredAiMaxSteps(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_MAX_STEPS ?? String(DEFAULT_AI_MAX_STEPS), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(16, parsed)) : DEFAULT_AI_MAX_STEPS;
}

function summarizeRouting(trace: PlatformRouteTrace[], truncated: boolean): PlatformRouteDecision {
  const first = trace[0]?.decision ?? {
    selectedSlugs: [],
    source: "policy_fallback" as const,
    model: null,
    rationale: "当前节点没有可用的已激活子平台。",
    confidence: null,
    degraded: false,
    costBearer: "platform" as const,
    budget: { maxInputCharacters: 24_000, maxOutputTokens: 512 },
    usage: null,
  };
  const hasFallback = trace.some(({ decision }) => decision.source === "policy_fallback");
  const aiDecisions = trace.filter(({ decision }) => decision.source === "ai");
  const allUsageReported = aiDecisions.length > 0 && aiDecisions.every(({ decision }) => decision.usage !== null);
  const usage = allUsageReported
    ? aiDecisions.reduce(
      (total, { decision }) => ({
        promptTokens: total.promptTokens + (decision.usage?.promptTokens ?? 0),
        completionTokens: total.completionTokens + (decision.usage?.completionTokens ?? 0),
        totalTokens: total.totalTokens + (decision.usage?.totalTokens ?? 0),
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    )
    : null;
  const suffix = [
    trace.length > 1 ? `已递归处理 ${trace.length} 个平台节点。` : "",
    truncated ? "达到递归安全上限，剩余分支未继续调用。" : "",
  ].filter(Boolean).join(" ");
  return {
    ...first,
    source: hasFallback ? "policy_fallback" : first.source,
    model: first.model ?? aiDecisions.find(({ decision }) => decision.model)?.decision.model ?? null,
    rationale: `${first.rationale}${suffix ? ` ${suffix}` : ""}`.slice(0, 1_000),
    degraded: first.degraded || hasFallback || trace.some(({ decision }) => decision.degraded) || truncated,
    usage,
  };
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
            CASE WHEN $3::text = '/' THEN '/' || r.slug
                 ELSE $3::text || '/' || r.slug
            END AS path,
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
              AND o."parentOrganizationId" = current_node.id))
      ORDER BY r.slug ASC`,
    [currentSlug, rootTenantId, platformPath],
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
