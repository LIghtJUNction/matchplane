import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { admitPlatformAiCall } from "../../../../src/platform-ai-admission";
import {
  decidePlatformRoutes,
  isPlatformRouterConfigured,
  PlatformRouterQuotaExceededError,
  type PlatformRouteDecision,
} from "../../../../src/platform-router";
import {
  readPublicStores,
  storeRouteCandidates,
} from "../../../../src/store-directory";
import { searchPublicStoreOffers } from "../../../../src/storefront-search";
import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { requestSearchParams } from "../../../../src/lib/request-url";
import { isUuid } from "../../../../src/lib/uuid";
import { jsonError } from "../../../../src/lib/json-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GUEST_COOKIE = "matchplane_guest";
const MAX_NARRATIVE_LENGTH = 8_000;
const DEFAULT_GUEST_AI_REQUESTS_PER_HOUR = 20;
const DEFAULT_GLOBAL_AI_REQUESTS_PER_HOUR = 120;

interface MallSearchInput {
  narrative?: string;
  storePath?: string;
}

/** Public browse feed. It reads canonical active offers without invoking the routing model. */
export async function GET(request: Request): Promise<Response> {
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(rootTenantId)) return jsonError("商城尚未完成初始化", 503);
  const requestedStorePath = normalizeStorePath(
    requestSearchParams(request).get("storePath") ?? undefined,
  );

  try {
    let stores = await readPublicStores(rootTenantId);
    if (requestedStorePath)
      stores = stores.filter((store) => store.path === requestedStorePath);
    const recommendations = await searchPublicStoreOffers({
      stores,
      narrative: "",
      limit: 24,
    });
    return NextResponse.json(
      {
        stores: stores.map((store) => ({
          slug: store.slug,
          path: store.path,
          displayName: store.displayName,
        })),
        recommendations,
      },
      {
        headers: {
          "cache-control": "public, max-age=30, stale-while-revalidate=120",
        },
      },
    );
  } catch (error) {
    console.error("mall browse feed failed", error);
    return jsonError("商品目录暂时不可用，请稍后重试", 503);
  }
}

/**
 * Public, contact-free shopping search.
 *
 * The model may select only active stores from PostgreSQL. Product cards are then re-read from
 * the root canonical offer projection, so neither an external store nor the model can invent a
 * price, product image, offer identity, or contact detail.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);

  let input: MallSearchInput;
  try {
    input = await readJsonBody<MallSearchInput>(request, 64 * 1024);
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "请求体不能超过 64 KiB"
        : "请求体必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const narrative = input.narrative?.trim() ?? "";
  if (!narrative || [...narrative].length > MAX_NARRATIVE_LENGTH) {
    return jsonError("请用 1 到 8000 个字符描述想买的商品", 400);
  }
  const requestedStorePath = normalizeStorePath(input.storePath);
  if (input.storePath !== undefined && !requestedStorePath)
    return jsonError("店铺地址无效", 400);

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(rootTenantId)) return jsonError("商城尚未完成初始化", 503);

  let stores;
  try {
    stores = await readPublicStores(rootTenantId);
  } catch (error) {
    console.error("mall store directory failed", error);
    return jsonError("店铺目录暂时不可用", 503);
  }
  if (requestedStorePath) {
    stores = stores.filter((store) => store.path === requestedStorePath);
    if (!stores.length) return jsonError("没有找到这个店铺", 404);
  }

  const requestId = randomUUID();
  const identity = await shoppingIdentity(request);
  let routing: PlatformRouteDecision;
  try {
    routing = requestedStorePath
      ? fixedStoreDecision(stores[0]?.slug ?? "")
      : await decidePlatformRoutes({
          platformPath: "/",
          narrative,
          candidates: storeRouteCandidates(stores),
          admitCall: isPlatformRouterConfigured()
            ? async () => {
                if (
                  !(await admitPlatformAiCall({
                    subject: identity.subject,
                    requestId,
                    platformPath: "/",
                    perSubjectLimit: configuredGuestAiRequestsPerHour(),
                    globalLimit: configuredGlobalAiRequestsPerHour(),
                  }))
                )
                  throw new PlatformRouterQuotaExceededError();
              }
            : undefined,
        });
  } catch (error) {
    if (error instanceof PlatformRouterQuotaExceededError) {
      return jsonError(error.message, 429, { "retry-after": "3600" });
    }
    console.error("mall shopping assistant failed", error);
    return jsonError("商城导购暂时不可用，请稍后重试", 503);
  }

  const selected = requestedStorePath
    ? stores
    : stores.filter((store) => routing.selectedSlugs.includes(store.slug));
  let recommendations;
  try {
    recommendations = await searchPublicStoreOffers({
      stores: selected,
      narrative,
      limit: 12,
    });
    await recordSearch({
      requestId,
      subject: identity.subject,
      narrative,
      selected,
      routing,
    });
  } catch (error) {
    console.error("mall product search failed", error);
    return jsonError("商品搜索暂时不可用，请稍后重试", 503);
  }

  const response = NextResponse.json(
    {
      requestId,
      stores: selected.map((store) => ({
        slug: store.slug,
        path: store.path,
        displayName: store.displayName,
      })),
      recommendations,
      routing: {
        source: routing.source,
        degraded: routing.degraded,
        rationale: routing.rationale,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
  if (identity.newCookie) {
    response.cookies.set(GUEST_COOKIE, identity.newCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return response;
}

async function shoppingIdentity(
  request: Request,
): Promise<{ subject: string; newCookie: string | null }> {
  const session = await auth.api
    .getSession({ headers: request.headers })
    .catch(() => null);
  const userId = session?.user?.id;
  if (typeof userId === "string" && userId.length > 0)
    return { subject: userId, newCookie: null };
  const existing = readCookie(request.headers.get("cookie"), GUEST_COOKIE);
  const token =
    existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)
      ? existing
      : randomUUID().replaceAll("-", "");
  return {
    subject: `guest:${createHash("sha256").update(token).digest("hex")}`,
    newCookie: token === existing ? null : token,
  };
}

async function recordSearch(input: {
  requestId: string;
  subject: string;
  narrative: string;
  selected: Awaited<ReturnType<typeof readPublicStores>>;
  routing: PlatformRouteDecision;
}): Promise<void> {
  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const routePlan = input.selected.map((store) => ({
      slug: store.slug,
      path: store.path,
      tenantId: store.tenantId,
      domainId: store.domainId,
      displayName: store.displayName,
      depth: 1,
    }));
    await client.query(
      `INSERT INTO platform_match_requests
        (id, auth_user_id, platform_path, narrative, route_plan, routing_decision, status)
       VALUES ($1::uuid, $2, '/', $3, $4::jsonb, $5::jsonb, $6)`,
      [
        input.requestId,
        input.subject,
        minimizeAuditNarrative(input.narrative),
        JSON.stringify(routePlan),
        JSON.stringify(input.routing),
        input.routing.degraded ? "degraded" : "completed",
      ],
    );
    await client.query(
      `INSERT INTO platform_ai_usage
        (id, match_request_id, auth_user_id, platform_path, source, cost_bearer,
         model, max_input_characters, max_output_tokens, prompt_tokens,
         completion_tokens, total_tokens, model_calls, degraded)
       VALUES ($1::uuid, $2::uuid, $3, '/', $4, 'platform', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        randomUUID(),
        input.requestId,
        input.subject,
        input.routing.source,
        input.routing.model,
        input.routing.budget.maxInputCharacters,
        input.routing.budget.maxOutputTokens,
        input.routing.usage?.promptTokens ?? null,
        input.routing.usage?.completionTokens ?? null,
        input.routing.usage?.totalTokens ?? null,
        input.routing.source === "ai" ? 1 : 0,
        input.routing.degraded,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

function minimizeAuditNarrative(value: string): string {
  return value
    .slice(0, 2_000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[phone]");
}

function fixedStoreDecision(slug: string): PlatformRouteDecision {
  return {
    selectedSlugs: slug ? [slug] : [],
    source: "policy_fallback",
    routeMechanism: "policy_fallback",
    model: null,
    rationale: "用户正在浏览指定店铺，直接在该店铺的公开商品中检索。",
    confidence: null,
    degraded: false,
    costBearer: "platform",
    budget: { maxInputCharacters: 24_000, maxOutputTokens: 512 },
    usage: null,
  };
}

function normalizeStorePath(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  return /^\/[a-z0-9][a-z0-9-]{1,62}$/.test(normalized) ? normalized : null;
}

function readCookie(header: string | null, name: string): string | null {
  for (const entry of header?.split(";") ?? []) {
    const [key, ...rest] = entry.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function configuredGuestAiRequestsPerHour(): number {
  return boundedInteger(
    process.env.MATCHPLANE_GUEST_AI_REQUESTS_PER_HOUR,
    DEFAULT_GUEST_AI_REQUESTS_PER_HOUR,
    1_000,
  );
}

function configuredGlobalAiRequestsPerHour(): number {
  return boundedInteger(
    process.env.MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR,
    DEFAULT_GLOBAL_AI_REQUESTS_PER_HOUR,
    100_000,
  );
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(maximum, parsed))
    : fallback;
}
