import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { admitPlatformAiCall } from "../../../../src/platform-ai-admission";
import {
  answerPlatformShoppingQuestion,
  isPlatformRouterConfigured,
  PlatformAssistantUnavailableError,
  PlatformRouterQuotaExceededError,
  type ShoppingConversationMessage,
} from "../../../../src/platform-router";
import { readPublicStores } from "../../../../src/store-directory";
import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { getPlatformRouterEffectiveStatus } from "../../../../src/lib/platform-router-config";
import { configuredTenantId } from "../../../../src/lib/store-access";
import {
  parseShoppingMemoryMutation,
  readShoppingMemory,
  writeShoppingMemory,
} from "../../../../src/shopping-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GUEST_COOKIE = "matchplane_guest";
const MAX_QUESTION_LENGTH = 2_000;
const PER_SUBJECT_LIMIT = 20;
const GLOBAL_LIMIT = 120;

/** Bounded, tool-calling conversational AI for the public shopping surface. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return error("请求来源未被商城信任", 403);
  const requestId = randomUUID();
  const providerStatus = getPlatformRouterEffectiveStatus();
  if (!providerStatus.ready)
    return error(
      "商城 AI 导购正在配置中，请稍后再试。",
      503,
      { "x-request-id": requestId },
      {
        code: "upstream_configuration",
        status: "degraded",
        retryable: false,
        requestId,
        provider: {
          source: providerStatus.source,
          issues: providerStatus.issues,
          credentialConfigured: providerStatus.credentialConfigured,
        },
      },
    );
  let body: { messages?: unknown; question?: unknown; storePath?: unknown };
  try {
    body = (await readJsonBody(request, 16 * 1024)) as typeof body;
  } catch (cause) {
    return error(
      cause instanceof RequestBodyTooLargeError
        ? "会话上下文不能超过 16 KiB"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const messages = parseShoppingConversation(body);
  const question = messages.at(-1)?.content ?? "";
  if (!question || question.length > MAX_QUESTION_LENGTH) {
    return error("请用 1 到 2000 个字符提问", 400);
  }
  const requestedStorePath = normalizeStorePath(body.storePath);
  if (body.storePath !== undefined && !requestedStorePath)
    return error("店铺地址无效", 400);
  if (!isPlatformRouterConfigured())
    return error("商品搜索尚未配置完整，请稍后再试。", 503);
  const tenantId = configuredTenantId();
  if (!tenantId) return error("商城尚未完成初始化", 503);
  const identity = await shoppingIdentity(request);
  try {
    let stores = await readPublicStores(tenantId);
    if (requestedStorePath) {
      stores = stores.filter((store) => store.path === requestedStorePath);
      if (!stores.length) return error("没有找到这个店铺", 404);
    }
    let memory = identity.authUserId
      ? await readShoppingMemory(tenantId, identity.authUserId).catch(() => {
          process.stderr.write(
            `[mall-assistant] ${JSON.stringify({ requestId, status: "memory_lookup_failed" })}\n`,
          );
          return null;
        })
      : null;
    const updateMemory =
      identity.authUserId && memory?.enabled
        ? async (facts: Parameters<typeof parseShoppingMemoryMutation>[0]) => {
            const mutation = parseShoppingMemoryMutation({
              enabled: true,
              facts,
              expectedVersion: memory?.version ?? 0,
            });
            const saved = await writeShoppingMemory({
              tenantId,
              authUserId: identity.authUserId!,
              mutation,
              source: "conversation_summary",
            });
            if (!saved)
              throw new Error("购物记忆已在其他页面更新，请重试本次对话");
            memory = saved;
            return saved;
          }
        : undefined;
    const reply = await answerPlatformShoppingQuestion({
      question,
      messages,
      stores,
      memory,
      ...(requestedStorePath
        ? {
            storeContext: {
              path: requestedStorePath,
              name: stores[0]!.displayName,
            },
          }
        : {}),
      updateMemory,
      admitCall: async () => {
        const admitted = await admitPlatformAiCall({
          subject: identity.subject,
          requestId,
          platformPath: requestedStorePath ?? "/",
          perSubjectLimit: boundedInteger(
            process.env.MATCHPLANE_GUEST_AI_REQUESTS_PER_HOUR,
            PER_SUBJECT_LIMIT,
            1_000,
          ),
          globalLimit: boundedInteger(
            process.env.MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR,
            GLOBAL_LIMIT,
            100_000,
          ),
        });
        if (!admitted) throw new PlatformRouterQuotaExceededError();
      },
      requestId,
      signal: request.signal,
    });
    await recordAssistantUsage({
      requestId,
      subject: identity.subject,
      question,
      model: reply.model,
      usage: reply.usage,
      modelCalls: reply.modelCalls,
      toolCalls: reply.toolCalls,
    });
    const response = NextResponse.json(
      {
        requestId,
        answer: reply.text,
        recommendations: reply.recommendations,
        uiActions: reply.uiActions,
        ...(reply.searchTrace ? { searchTrace: reply.searchTrace } : {}),
        ...(reply.outcome ? { outcome: reply.outcome } : {}),
      },
      { headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
    if (identity.newCookie)
      response.cookies.set(GUEST_COOKIE, identity.newCookie, guestCookie());
    return response;
  } catch (cause) {
    if (cause instanceof PlatformRouterQuotaExceededError)
      return error(
        cause.message,
        429,
        { "retry-after": "3600", "x-request-id": requestId },
        { code: "platform_quota", retryable: true, requestId },
      );
    if (cause instanceof PlatformAssistantUnavailableError)
      return providerErrorResponse(cause, requestId);
    process.stderr.write(
      `[mall-assistant] ${JSON.stringify({ requestId, status: "internal_error" })}\n`,
    );
    return error(
      "商品搜索暂时不可用，请稍后再试。",
      503,
      { "x-request-id": requestId },
      { code: "assistant_unavailable", retryable: true, requestId },
    );
  }
}

async function recordAssistantUsage(input: {
  requestId: string;
  subject: string;
  question: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  modelCalls: number;
  toolCalls: string[];
}): Promise<void> {
  await authDatabase.query(
    `WITH request AS (
       INSERT INTO platform_match_requests (id, auth_user_id, platform_path, narrative, route_plan, routing_decision, status)
       VALUES (
                     $1::uuid,
                     $2,
                     '/',
                     $3,
                     '[]'::jsonb,
                     jsonb_build_object(
                                   'kind', 'assistant',
                                   'costBearer', 'platform',
                                   'toolCalls', $9::jsonb
                     ),
                     'completed'
       )
       RETURNING id
     )
     INSERT INTO platform_ai_usage
       (id, match_request_id, auth_user_id, platform_path, source, cost_bearer, model,
        max_input_characters, max_output_tokens, prompt_tokens, completion_tokens, total_tokens, model_calls, degraded)
     SELECT $4::uuid, id, $2, '/', 'ai', 'platform', $5, 12000, 320, $6, $7, $8, $10, false FROM request`,
    [
      input.requestId,
      input.subject,
      minimizeQuestion(input.question),
      randomUUID(),
      input.model,
      input.usage?.promptTokens ?? null,
      input.usage?.completionTokens ?? null,
      input.usage?.totalTokens ?? null,
      JSON.stringify(input.toolCalls.slice(0, 16)),
      Math.max(0, Math.min(16, Math.trunc(input.modelCalls))),
    ],
  );
}

function parseShoppingConversation(body: {
  messages?: unknown;
  question?: unknown;
}): ShoppingConversationMessage[] {
  const raw = Array.isArray(body.messages)
    ? body.messages
    : typeof body.question === "string"
      ? [{ role: "user", content: body.question }]
      : [];
  if (raw.length === 0 || raw.length > 24) return [];
  let totalCharacters = 0;
  const messages: ShoppingConversationMessage[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const role = (value as { role?: unknown }).role;
    const content = (value as { content?: unknown }).content;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string"
    ) {
      return [];
    }
    const bounded = content.trim();
    if (!bounded || bounded.length > MAX_QUESTION_LENGTH) return [];
    totalCharacters += bounded.length;
    if (totalCharacters > 12_000) return [];
    messages.push({ role, content: bounded });
  }
  return messages.at(-1)?.role === "user" ? messages : [];
}

async function shoppingIdentity(request: Request): Promise<{
  subject: string;
  authUserId: string | null;
  newCookie: string | null;
}> {
  const session = await auth.api
    .getSession({ headers: request.headers })
    .catch(() => null);
  if (session?.user?.id)
    return {
      subject: session.user.id,
      authUserId: session.user.id,
      newCookie: null,
    };
  const existing = readCookie(request.headers.get("cookie"), GUEST_COOKIE);
  const token =
    existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)
      ? existing
      : randomUUID().replaceAll("-", "");
  return {
    subject: `guest:${createHash("sha256").update(token).digest("hex")}`,
    authUserId: null,
    newCookie: token === existing ? null : token,
  };
}

function guestCookie() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

function normalizeStorePath(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return null;
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  return /^\/[a-z0-9][a-z0-9-]{1,62}$/.test(normalized) ? normalized : null;
}

function minimizeQuestion(value: string): string {
  return value
    .slice(0, 2_000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[phone]");
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

function readCookie(header: string | null, name: string): string | null {
  for (const entry of header?.split(";") ?? []) {
    const [key, ...rest] = entry.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function providerErrorResponse(
  cause: PlatformAssistantUnavailableError,
  requestId: string,
): Response {
  const headers: Record<string, string> = { "x-request-id": requestId };
  let status = 503;
  let code = `provider_${cause.kind}`;
  if (
    cause.kind === "connect_timeout" ||
    cause.kind === "first_byte_timeout" ||
    cause.kind === "total_timeout"
  ) {
    status = 504;
    headers["retry-after"] = "5";
  } else if (cause.kind === "network_policy") {
    status = 503;
    code = "upstream_configuration";
  } else if (
    cause.kind === "no_final_text" ||
    cause.kind === "malformed_response" ||
    cause.kind === "upstream_http"
  ) {
    status = 502;
    if (cause.retryable) headers["retry-after"] = "5";
  } else if (cause.kind === "quota") {
    headers["retry-after"] = "60";
  } else if (cause.kind === "tool_failure") {
    if (cause.retryable) headers["retry-after"] = "5";
  } else if (cause.kind === "aborted") {
    status = 499;
    code = "request_aborted";
  }
  return error(cause.message, status, headers, {
    code,
    retryable: cause.retryable,
    requestId,
  });
}

function error(
  message: string,
  status: number,
  headers: Record<string, string> = {},
  metadata?: {
    code: string;
    retryable: boolean;
    requestId: string;
    status?: "degraded";
    provider?: {
      source: "managed" | "environment" | "unconfigured";
      issues: string[];
      credentialConfigured: boolean;
    };
  },
): Response {
  return NextResponse.json(
    { error: message, ...(metadata ?? {}) },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}
