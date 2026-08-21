import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { getManagedPlatformRouterConfig, saveManagedPlatformRouterConfig, type ManagedRouterProtocol } from "../../../../../src/lib/platform-router-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const guard = await requireSuperAdmin(request, false);
  if (guard instanceof Response) return guard;
  return NextResponse.json({ config: getManagedPlatformRouterConfig() }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request): Promise<Response> {
  const guard = await requireSuperAdmin(request, true);
  if (guard instanceof Response) return guard;
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) return error("AI 配置必须是对象", 400);
    body = value as Record<string, unknown>;
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "AI 配置请求过大" : "AI 配置必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  try {
    const config = saveManagedPlatformRouterConfig({
      endpoint: text(body.endpoint),
      model: text(body.model),
      protocol: body.protocol as ManagedRouterProtocol,
      enabled: body.enabled === true,
      apiKey: optionalText(body.apiKey),
      assistantInstructions: optionalText(body.assistantInstructions),
      assistantMaxOutputTokens: numberValue(body.assistantMaxOutputTokens),
      assistantTemperature: numberValue(body.assistantTemperature),
      assistantMaxSteps: numberValue(body.assistantMaxSteps),
      assistantTimeoutMs: numberValue(body.assistantTimeoutMs),
      assistantReasoningEffort: optionalText(body.assistantReasoningEffort),
      modelReasoningEfforts: Array.isArray(body.modelReasoningEfforts) ? body.modelReasoningEfforts : undefined,
    });
    return NextResponse.json({ config }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "AI 配置保存失败", 400);
  }
}

async function requireSuperAdmin(request: Request, write: boolean): Promise<true | Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401);
  const role = (session.user as { role?: string | null }).role;
  if (write ? role !== "rootSuperAdmin" : role !== "rootSuperAdmin" && role !== "rootAdmin") return error(write ? "只有超级管理员可以保存 AI 配置" : "只有根平台管理员可以查看 AI 配置", 403);
  return true;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function error(message: string, status: number): Response { return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } }); }
