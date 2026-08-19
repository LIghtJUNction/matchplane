import { NextResponse } from "next/server";

import { auth } from "../../../../../../../src/lib/auth";
import { readJsonBody, readResponseTextBody } from "../../../../../../../src/lib/body-limit";
import { loadInternalBearer } from "../../../../../../../src/lib/internal-auth";
import { hasTrustedBrowserOrigin } from "../../../../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Activate one generic offer through the Rust gateway's operator boundary.
 *
 * The web admin session authorizes the action, but it never receives the gateway bearer.  The
 * Rust storage layer remains the authority for the draft -> active state transition and its
 * audit/invariant checks.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return jsonError("只有根平台管理员可以激活供给", 403);
  }

  const { offerId } = await context.params;
  if (!isUuid(offerId)) return jsonError("offerId 必须是 UUID", 400);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!tenantId || !isUuid(tenantId)) return jsonError("根平台 tenant 尚未配置", 503);

  let body: Record<string, unknown> = {};
  try {
    const parsed = await readJsonBody<unknown>(request, 32 * 1024);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("供给审核请求必须是有效 JSON", 400);
  }
  if (body.tenant_id !== undefined && body.tenant_id !== tenantId) {
    return jsonError("供给审核只能访问当前根平台 tenant", 403);
  }

  let bearer: string;
  try {
    bearer = await loadInternalBearer("MATCHPLANE_GATEWAY_ADMIN_TOKEN", "MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE");
  } catch {
    return jsonError("网关管理员密钥尚未配置", 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${process.env.MATCHPLANE_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8080"}/v1/admin/marketplace/offers/${encodeURIComponent(offerId)}/activate`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ tenant_id: tenantId }),
        cache: "no-store",
      },
    );
  } catch (error) {
    console.error("marketplace offer activation bridge unavailable", error);
    return jsonError("网关审核服务暂时不可用", 503);
  }

  try {
    return new Response(await readResponseTextBody(upstream, 256 * 1024), {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return jsonError("网关审核服务返回内容过大或无效", 502);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
