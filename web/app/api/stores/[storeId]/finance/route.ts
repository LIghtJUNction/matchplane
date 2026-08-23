import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { readResponseTextBody } from "../../../../../src/lib/body-limit";
import { loadInternalBearer } from "../../../../../src/lib/internal-auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  configuredTenantId,
  isUuid,
  readStoreAccess,
  roleOf,
} from "../../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumWindowMilliseconds = 366 * 24 * 60 * 60 * 1_000;

export async function GET(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return error("请求来源未被商城信任", 403);
  const { storeId } = await context.params;
  if (!isUuid(storeId)) return error("店铺编号无效", 400);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("请登录商家账号", 401);
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store || !access.canManageStore)
    return error("只有店主或商城后台可以查看财务报表", 403);
  const tenantId = configuredTenantId();
  if (!tenantId) return error("商城尚未完成初始化", 503);

  let query: URLSearchParams;
  try {
    query = new URL(request.url).searchParams;
  } catch {
    return error("报表请求地址无效", 400);
  }
  const window = financeWindow(query.get("from"), query.get("to"));
  if (!window) return error("报表时间范围无效，最长支持 366 天", 400);

  let token: string;
  try {
    token = await loadInternalBearer(
      "MATCHPLANE_PAYMENT_ADMIN_TOKEN",
      "MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE",
    );
  } catch (cause) {
    console.error("store finance token is unavailable", cause);
    return error("财务服务尚未配置", 503);
  }

  const upstream = new URL(
    "/v1/admin/financial-report",
    process.env.MATCHPLANE_PAYMENT_INTERNAL_URL ?? "http://127.0.0.1:8081",
  );
  upstream.searchParams.set("tenant_id", tenantId);
  upstream.searchParams.set("source_type", "store");
  upstream.searchParams.set("source_ref", access.store.id);
  upstream.searchParams.set("from", window.from);
  upstream.searchParams.set("to", window.to);
  upstream.searchParams.set("limit", "500");

  let response: Response;
  try {
    response = await fetch(upstream, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (cause) {
    console.error("store finance service is unavailable", cause);
    return error("财务服务暂时不可用", 503);
  }
  try {
    return new Response(await readResponseTextBody(response, 2 * 1024 * 1024), {
      status: response.status,
      headers: {
        "cache-control": "no-store",
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return error("财务服务返回内容过大或无效", 502);
  }
}

function financeWindow(
  fromInput: string | null,
  toInput: string | null,
): { from: string; to: string } | null {
  const now = new Date();
  const from = fromInput
    ? new Date(fromInput)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = toInput ? new Date(toInput) : now;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    return null;
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > maximumWindowMilliseconds) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
