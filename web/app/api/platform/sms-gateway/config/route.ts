import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  getManagedSmsGatewayConfig,
  saveManagedSmsGatewayConfig,
} from "../../../../../src/lib/sms-gateway-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const guard = await requireMallOwner(request, false);
  if (guard instanceof Response) return guard;
  return NextResponse.json({ config: getManagedSmsGatewayConfig() }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request): Promise<Response> {
  const guard = await requireMallOwner(request, true);
  if (guard instanceof Response) return guard;
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) return error("短信网关配置必须是对象", 400);
    body = value as Record<string, unknown>;
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "配置请求过大" : "配置必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  try {
    const config = saveManagedSmsGatewayConfig({
      enabled: body.enabled === true,
      gatewayUrl: typeof body.gatewayUrl === "string" ? body.gatewayUrl : "",
      token: typeof body.token === "string" && body.token.length ? body.token : undefined,
    });
    // The sender resolves this file on every delivery, so no restart is needed.
    return NextResponse.json({ config }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "短信网关配置保存失败", 400);
  }
}

async function requireMallOwner(request: Request, write: boolean): Promise<true | Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401);
  const role = (session.user as { role?: string | null }).role;
  if (write ? role !== "rootSuperAdmin" : role !== "rootSuperAdmin" && role !== "rootAdmin") {
    return error(write ? "只有商城负责人可以保存短信网关配置" : "只有商城后台人员可以查看短信网关配置", 403);
  }
  return true;
}

function error(message: string, status: number): Response { return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } }); }
