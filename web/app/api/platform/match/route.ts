import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import {
  decidePlatformRoutes,
  isPlatformRouterConfigured,
  PlatformRouterQuotaExceededError,
  type PlatformRouteDecision,
} from "../../../../src/platform-router";
import { expandPlatformRouteTree, type PlatformRouteTrace } from "../../../../src/platform-orchestrator";
import { readActiveDirectChildRoutes } from "../../../../src/platform-child-routes";
import {
  isMountedPlatformPath,
  isPlatformPathAccessibleByOrganization,
} from "../../../../src/platform-mount";
import { authenticatePlatformRequest } from "../../../../src/platform-request-auth";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

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
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const actor = await authenticatePlatformRequest(request);
  if (!actor) return NextResponse.json({ error: "Better Auth session or platform API key is required" }, { status: 401 });

  const input = await parseBody(request);
  const narrative = input.narrative?.trim() ?? "";
  const platformPath = normalizePlatformPath(input.platformPath);
  if (!narrative || narrative.length > MAX_NARRATIVE_LENGTH) {
    return NextResponse.json({ error: "narrative must contain 1..=10000 characters" }, { status: 400 });
  }
  if (!platformPath) {
    return NextResponse.json({ error: "platformPath is invalid" }, { status: 400 });
  }
  if (!(await isMountedPlatformPath(platformPath))) {
    return NextResponse.json({ error: "平台路径尚未激活" }, { status: 404 });
  }
  if (actor.organizationId && !(await isPlatformPathAccessibleByOrganization(platformPath, actor.organizationId))) {
    return NextResponse.json({ error: "API key 不能访问该平台节点" }, { status: 403 });
  }

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  const viewer = {
    authUserId: actor.access === "session" ? actor.subject : null,
    organizationId: actor.organizationId,
  };
  const candidates = rootTenantId && isUuid(rootTenantId)
    ? await readActiveDirectChildRoutes(platformPath, rootTenantId, viewer)
    : [];
  const requestId = randomUUID();
  let recursive: Awaited<ReturnType<typeof expandPlatformRouteTree>>;
  try {
    recursive = await expandPlatformRouteTree({
      platformPath,
      narrative,
      candidates,
      loadChildren: async (childPath) => readActiveDirectChildRoutes(childPath, rootTenantId ?? "", viewer),
      decide: ({ platformPath: currentPath, narrative: currentNarrative, candidates: currentCandidates }) =>
        decidePlatformRoutes({
          platformPath: currentPath,
          narrative: currentNarrative,
          candidates: currentCandidates.map(({ tenantId: _tenantId, domainId: _domainId, ...candidate }) => candidate),
          admitCall: isPlatformRouterConfigured()
            ? async () => {
                if (!(await admitPlatformAiCall({
                  authUserId: actor.subject,
                  requestId,
                  platformPath: currentPath,
                  perSubjectLimit: configuredAiRequestsPerHour(),
                  globalLimit: configuredAiGlobalRequestsPerHour(),
                }))) {
                  throw new PlatformRouterQuotaExceededError();
                }
              }
            : undefined,
        }),
      maxSteps: configuredAiMaxSteps(),
      maxDepth: configuredAiMaxSteps(),
    });
  } catch (error) {
    if (error instanceof PlatformRouterQuotaExceededError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "retry-after": "3600", "cache-control": "no-store" } },
      );
    }
    console.error("platform route expansion failed", error);
    return NextResponse.json({ error: "平台路由暂时不可用，请稍后再试。" }, { status: 503 });
  }
  const routing = summarizeRouting(recursive.trace, recursive.truncated);
  const routePlan = recursive.routePlan;
  const modelCalls = recursive.trace.filter(({ decision }) => decision.source === "ai").length;
  const status = routePlan.length === 0
    ? "accepted"
    : routing.degraded
      ? "degraded"
      : "delegated";
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
        actor.subject,
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
         completion_tokens, total_tokens, model_calls, degraded)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        randomUUID(),
        requestId,
        actor.subject,
        platformPath,
        routing.source,
        routing.costBearer,
        routing.model,
        routing.budget.maxInputCharacters,
        routing.budget.maxOutputTokens,
        routing.usage?.promptTokens ?? null,
        routing.usage?.completionTokens ?? null,
        routing.usage?.totalTokens ?? null,
        modelCalls,
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
      access: actor.access,
    },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Serialize admission per subject and reserve exactly one provider call. The
 * reservation is made before fetch, so concurrent requests cannot all observe
 * the same remaining quota and overspend the platform's model budget.
 */
async function admitPlatformAiCall(input: {
  authUserId: string;
  requestId: string;
  platformPath: string;
  perSubjectLimit: number;
  globalLimit: number;
}): Promise<boolean> {
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    // The per-subject limit prevents one identity from monopolizing the hosted router; the
    // global limit prevents a large number of verified identities from multiplying the
    // platform's provider bill without an operator changing an explicit deployment setting.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('matchplane:platform-ai:global'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.authUserId]);
    await client.query(
      `DELETE FROM platform_ai_call_admissions
        WHERE created_at < clock_timestamp() - interval '2 hours'`,
    );
    const globalRecent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM platform_ai_call_admissions
        WHERE created_at >= clock_timestamp() - interval '1 hour'`,
    );
    if (Number(globalRecent.rows[0]?.count ?? 0) >= input.globalLimit) {
      await client.query("ROLLBACK");
      return false;
    }
    const recent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM platform_ai_call_admissions
        WHERE auth_user_id = $1
          AND created_at >= clock_timestamp() - interval '1 hour'`,
      [input.authUserId],
    );
    const count = Number(recent.rows[0]?.count ?? 0);
    if (count >= input.perSubjectLimit) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO platform_ai_call_admissions
        (id, auth_user_id, request_id, platform_path)
       VALUES ($1::uuid, $2, $3::uuid, $4)`,
      [randomUUID(), input.authUserId, input.requestId, input.platformPath],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function configuredAiRequestsPerHour(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR ?? String(DEFAULT_AI_REQUESTS_PER_HOUR), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(10_000, parsed)) : DEFAULT_AI_REQUESTS_PER_HOUR;
}

function configuredAiGlobalRequestsPerHour(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR ?? String(DEFAULT_AI_REQUESTS_PER_HOUR), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(100_000, parsed)) : DEFAULT_AI_REQUESTS_PER_HOUR;
}

function configuredAiMaxSteps(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_MAX_STEPS ?? String(DEFAULT_AI_MAX_STEPS), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(16, parsed)) : DEFAULT_AI_MAX_STEPS;
}

function summarizeRouting(trace: PlatformRouteTrace[], truncated: boolean): PlatformRouteDecision {
  const first = trace[0]?.decision ?? {
    selectedSlugs: [],
    source: "policy_fallback" as const,
    routeMechanism: "policy_fallback" as const,
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
    routeMechanism: hasFallback ? "policy_fallback" : first.routeMechanism,
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

async function parseBody(request: Request): Promise<MatchRequest> {
  try {
    const body = (await request.json()) as MatchRequest;
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

function normalizePlatformPath(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) return null;
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  if (normalized === "/") return normalized;
  return /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(normalized) ? normalized : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
