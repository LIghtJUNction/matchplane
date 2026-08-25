import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compatibility tombstone for clients from the previous release.
 *
 * Provider protocols do not expose one portable model-list contract. Model IDs
 * are configured manually and this route must never contact a provider.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return error("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401);
  if ((session.user as { role?: string | null }).role !== "rootSuperAdmin")
    return error("只有超级管理员可以配置模型", 403);
  return NextResponse.json(
    {
      code: "manual_model_configuration_required",
      error: "模型 ID 必须按供应商文档手动配置",
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
