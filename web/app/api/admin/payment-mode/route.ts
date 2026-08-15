import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";
import { loadInternalBearer } from "../../../../src/lib/internal-auth";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  return forward(request, "GET");
}

export async function POST(request: Request): Promise<Response> {
  return forward(request, "POST");
}

async function forward(request: Request, method: "GET" | "POST"): Promise<Response> {
  if (method === "POST" && !hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return NextResponse.json({ error: "根平台管理员权限不足" }, { status: 403 });
  }
  let token: string;
  try {
    token = await loadInternalBearer(
      "MATCHPLANE_PAYMENT_ADMIN_TOKEN",
      "MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE",
    );
  } catch (error) {
    console.error("payment admin token is unavailable", error);
    return NextResponse.json({ error: "支付管理服务尚未配置" }, { status: 503 });
  }
  const upstream = new URL(
    "/v1/admin/payment-mode",
    process.env.MATCHPLANE_PAYMENT_INTERNAL_URL ?? "http://127.0.0.1:8081",
  );
  if (method === "GET") upstream.search = new URL(request.url).search;
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });
  let body: string | undefined;
  if (method === "POST") {
    const input = (await request.json()) as Record<string, unknown>;
    input.actor = session.user.id;
    body = JSON.stringify(input);
    headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(upstream, { method, headers, body });
  } catch (error) {
    console.error("payment admin bridge unavailable", error);
    return NextResponse.json({ error: "支付管理服务暂时不可用" }, { status: 503 });
  }
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
