import { NextResponse } from "next/server";

import { auth } from "./auth";
import { readJsonBody, readResponseTextBody } from "./body-limit";
import { loadInternalBearer } from "./internal-auth";
import { hasTrustedBrowserOrigin } from "./request-origin";
import { requestSearchParams } from "./request-url";

const tenantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Server-only BFF for the payment administrator API. Browser code never receives the payment
 * bearer; the tenant is pinned to MATCHPLANE_ROOT_TENANT_ID when the caller omits it, and a
 * browser-supplied different tenant is rejected.
 */
export async function forwardPaymentAdmin(
  request: Request,
  upstreamPath: string,
  method: "GET" | "POST",
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json(
      { error: "请求来源未被平台信任" },
      { status: 403 },
    );
  }
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return NextResponse.json(
      { error: "根平台管理员权限不足" },
      { status: 403 },
    );
  }

  let token: string;
  try {
    token = await loadInternalBearer(
      "MATCHPLANE_PAYMENT_ADMIN_TOKEN",
      "MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE",
    );
  } catch (error) {
    console.error("payment admin token is unavailable", error);
    return NextResponse.json(
      { error: "支付管理服务尚未配置" },
      { status: 503 },
    );
  }

  let upstream: URL;
  try {
    upstream = new URL(
      upstreamPath,
      process.env.MATCHPLANE_PAYMENT_INTERNAL_URL ?? "http://127.0.0.1:8081",
    );
  } catch (error) {
    console.error("payment admin URL is invalid", error);
    return NextResponse.json(
      { error: "支付管理服务地址无效" },
      { status: 503 },
    );
  }
  let body: string | undefined;
  if (method === "GET") {
    const query = requestSearchParams(request);
    let tenantId: string;
    try {
      tenantId = pinnedTenantId(query.get("tenant_id"));
    } catch (error) {
      return (
        paymentAdminErrorResponse(error) ??
        NextResponse.json({ error: "tenant scope invalid" }, { status: 400 })
      );
    }
    upstream.searchParams.set("tenant_id", tenantId);
    for (const parameter of ["limit", "offset"] as const) {
      const value = query.get(parameter);
      if (value !== null) upstream.searchParams.set(parameter, value);
    }
  } else {
    let input: Record<string, unknown>;
    try {
      const parsed = await readJsonBody<unknown>(request, 64 * 1024);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json(
          { error: "支付管理请求必须是 JSON 对象" },
          { status: 400 },
        );
      }
      input = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "支付管理请求 JSON 无效" },
        { status: 400 },
      );
    }
    let tenantId: string;
    try {
      tenantId = pinnedTenantId(
        typeof input.tenant_id === "string" ? input.tenant_id : null,
      );
    } catch (error) {
      return (
        paymentAdminErrorResponse(error) ??
        NextResponse.json({ error: "tenant scope invalid" }, { status: 400 })
      );
    }
    input.tenant_id = tenantId;
    input.actor = session.user.id;
    body = JSON.stringify(input);
  }

  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(upstream, {
      method,
      headers,
      body,
      cache: "no-store",
    });
  } catch (error) {
    console.error("payment admin bridge unavailable", error);
    return NextResponse.json(
      { error: "支付管理服务暂时不可用" },
      { status: 503 },
    );
  }
  try {
    return new Response(await readResponseTextBody(response, 256 * 1024), {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "支付管理服务返回内容过大或无效" },
      { status: 502 },
    );
  }
}

function pinnedTenantId(requested: string | null): string {
  const configured = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!tenantIdPattern.test(configured)) {
    throw new Error("MATCHPLANE_ROOT_TENANT_ID is not configured");
  }
  if (requested && requested !== configured) {
    throw new TenantScopeError();
  }
  return configured;
}

class TenantScopeError extends Error {}

export function paymentAdminErrorResponse(error: unknown): Response | null {
  if (error instanceof TenantScopeError) {
    return NextResponse.json(
      { error: "支付管理只能访问当前根平台 tenant" },
      { status: 403 },
    );
  }
  if (
    error instanceof Error &&
    error.message === "MATCHPLANE_ROOT_TENANT_ID is not configured"
  ) {
    return NextResponse.json(
      { error: "根平台尚未配置 MATCHPLANE_ROOT_TENANT_ID" },
      { status: 503 },
    );
  }
  return null;
}
