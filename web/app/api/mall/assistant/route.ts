import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { admitPlatformAiCall } from "../../../../src/platform-ai-admission";
import {
  answerPlatformShoppingQuestion,
  isPlatformRouterConfigured,
  PlatformAssistantUnavailableError,
  PlatformRouterQuotaExceededError,
} from "../../../../src/platform-router";
import { readPublicStores } from "../../../../src/store-directory";
import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GUEST_COOKIE = "matchplane_guest";
const MAX_QUESTION_LENGTH = 2_000;
const PER_SUBJECT_LIMIT = 20;
const GLOBAL_LIMIT = 120;

/** Bounded, tool-calling conversational AI for the public shopping surface. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被商城信任", 403);
  let body: { question?: unknown; mode?: unknown };
  try {
    body = await readJsonBody(request, 16 * 1024) as typeof body;
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "问题不能超过 2000 个字符" : "请求必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > MAX_QUESTION_LENGTH) return error("请用 1 到 2000 个字符提问", 400);
  const mode = body.mode === "shopping" || body.mode === "conversation" ? body.mode : "capability";
  if (!isPlatformRouterConfigured()) return error("商城 AI 导购尚未配置完整，请稍后再试。", 503);
  const tenantId = configuredTenantId();
  if (!tenantId) return error("商城尚未完成初始化", 503);
  const requestId = randomUUID();
  const identity = await shoppingIdentity(request);
  try {
    const stores = await readPublicStores(tenantId);
    const reply = await answerPlatformShoppingQuestion({
      question,
      stores,
      mode,
      admitCall: async () => {
        const admitted = await admitPlatformAiCall({
          subject: identity.subject,
          requestId,
          platformPath: "/",
          perSubjectLimit: boundedInteger(process.env.MATCHPLANE_GUEST_AI_REQUESTS_PER_HOUR, PER_SUBJECT_LIMIT, 1_000),
          globalLimit: boundedInteger(process.env.MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR, GLOBAL_LIMIT, 100_000),
        });
        if (!admitted) throw new PlatformRouterQuotaExceededError();
      },
    });
    await recordAssistantUsage({ requestId, subject: identity.subject, question, model: reply.model, usage: reply.usage });
    const response = NextResponse.json({ requestId, answer: reply.text }, { headers: { "cache-control": "no-store" } });
    if (identity.newCookie) response.cookies.set(GUEST_COOKIE, identity.newCookie, guestCookie());
    return response;
  } catch (cause) {
    if (cause instanceof PlatformRouterQuotaExceededError) return error(cause.message, 429, { "retry-after": "3600" });
    if (cause instanceof PlatformAssistantUnavailableError) return error(cause.message, 502);
    console.error("mall assistant failed", cause);
    return error("商城 AI 导购暂时不可用，请稍后再试。", 503);
  }
}

async function recordAssistantUsage(input: { requestId: string; subject: string; question: string; model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }): Promise<void> {
  await authDatabase.query(
    `WITH request AS (
       INSERT INTO platform_match_requests (id, auth_user_id, platform_path, narrative, route_plan, routing_decision, status)
       VALUES ($1::uuid, $2, '/', $3, '[]'::jsonb, '{"kind":"assistant","costBearer":"platform"}'::jsonb, 'completed')
       RETURNING id
     )
     INSERT INTO platform_ai_usage
       (id, match_request_id, auth_user_id, platform_path, source, cost_bearer, model,
        max_input_characters, max_output_tokens, prompt_tokens, completion_tokens, total_tokens, model_calls, degraded)
     SELECT $4::uuid, id, $2, '/', 'ai', 'platform', $5, 2000, 320, $6, $7, $8, 1, false FROM request`,
    [input.requestId, input.subject, minimizeQuestion(input.question), randomUUID(), input.model, input.usage?.promptTokens ?? null, input.usage?.completionTokens ?? null, input.usage?.totalTokens ?? null],
  );
}

async function shoppingIdentity(request: Request): Promise<{ subject: string; newCookie: string | null }> {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (session?.user?.id) return { subject: session.user.id, newCookie: null };
  const existing = readCookie(request.headers.get("cookie"), GUEST_COOKIE);
  const token = existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing) ? existing : randomUUID().replaceAll("-", "");
  return { subject: `guest:${createHash("sha256").update(token).digest("hex")}`, newCookie: token === existing ? null : token };
}

function guestCookie() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 };
}

function configuredTenantId(): string | null {
  const value = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function minimizeQuestion(value: string): string {
  return value.slice(0, 2_000).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[phone]");
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function readCookie(header: string | null, name: string): string | null {
  for (const entry of header?.split(";") ?? []) {
    const [key, ...rest] = entry.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function error(message: string, status: number, headers: Record<string, string> = {}): Response {
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store", ...headers } });
}
