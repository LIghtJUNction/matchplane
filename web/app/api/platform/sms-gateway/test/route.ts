import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { sendSmsGatewayConfigTest } from "../../../../../src/lib/sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sends one fixed-content test code through the saved gateway. Unlike the root
 * email test, an operator rarely has a verified phone number before this very
 * gateway works, so the recipient is supplied per request — bounded to a strict
 * E.164 shape and to the mall owner role.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401);
  if ((session.user as { role?: string | null }).role !== "rootSuperAdmin") {
    return error("只有商城负责人可以发送短信测试", 403);
  }
  let phoneNumber: string;
  try {
    const body = await readJsonBody<unknown>(request, 4 * 1024);
    const value = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).phoneNumber : undefined;
    if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value.trim())) {
      return error("请填写 E.164 格式的手机号（如 +8613800000000）", 400);
    }
    phoneNumber = value.trim();
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "测试请求过大" : "测试请求必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  try {
    await sendSmsGatewayConfigTest(phoneNumber);
    return NextResponse.json({ status: "sent" }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "测试短信发送失败", 502);
  }
}

function error(message: string, status: number): Response { return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } }); }
