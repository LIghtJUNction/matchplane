import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { listManagedPlatformRouterModels, type ManagedRouterProtocol } from "../../../../../src/lib/platform-router-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401);
  if ((session.user as { role?: string | null }).role !== "rootSuperAdmin") return error("只有超级管理员可以获取模型列表", 403);
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) return error("模型请求必须是对象", 400);
    body = value as Record<string, unknown>;
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "模型请求过大" : "模型请求必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  try {
    const models = await listManagedPlatformRouterModels({
      endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
      protocol: body.protocol as ManagedRouterProtocol,
      apiKey: typeof body.apiKey === "string" && body.apiKey.length ? body.apiKey : undefined,
    });
    return NextResponse.json({ models }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "模型列表读取失败", 502);
  }
}

function error(message: string, status: number): Response { return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } }); }
