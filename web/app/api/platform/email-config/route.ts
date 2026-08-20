import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import {
  getRootEmailConfig,
  RootEmailConfigConflictError,
  saveRootEmailConfig,
  type RootEmailConfigInput,
} from "../../../../src/lib/root-email-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Root-auth SMTP control plane. It exposes metadata only; credentials remain in a host slot. */
export async function GET(request: Request): Promise<Response> {
  const session = await requireRootManager(request);
  if (session instanceof Response) return session;
  try {
    return NextResponse.json({ config: await getRootEmailConfig() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "根邮箱配置暂时不可用；请确认数据库迁移已完成" }, { status: 503 });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const session = await requireRootManager(request, { write: true });
  if (session instanceof Response) return session;
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, 32 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "根邮箱配置请求过大" : "根邮箱配置必须是有效 JSON" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "根邮箱配置必须是对象" }, { status: 400 });
  }
  const input = body as Partial<RootEmailConfigInput>;
  try {
    const config = await saveRootEmailConfig({
      providerKey: stringField(input.providerKey),
      smtpHost: stringField(input.smtpHost),
      smtpPort: input.smtpPort as number,
      tlsMode: input.tlsMode as RootEmailConfigInput["tlsMode"],
      username: stringField(input.username),
      credentialSlot: stringField(input.credentialSlot),
      fromAddress: stringField(input.fromAddress),
      replyTo: optionalString(input.replyTo),
      mode: input.mode as RootEmailConfigInput["mode"],
      enabled: input.enabled === true,
      expectedVersion: optionalVersion(input.expectedVersion),
      actorUserId: session.user.id,
    });
    return NextResponse.json({ config }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RootEmailConfigConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "根邮箱配置保存失败" }, { status: 400 });
  }
}

async function requireRootManager(request: Request, options: { write?: boolean } = {}): Promise<{ user: { id: string; role?: string | null } } | Response> {
  if (!hasTrustedBrowserOrigin(request)) return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "需要登录" }, { status: 401 });
  const user = session.user as { id: string; role?: string | null };
  const allowed = options.write ? user.role === "rootSuperAdmin" : user.role === "rootSuperAdmin" || user.role === "rootAdmin";
  if (!allowed) return NextResponse.json({ error: options.write ? "只有超级管理员可以修改根邮箱配置" : "只有根平台管理员可以查看根邮箱配置" }, { status: 403 });
  return { user };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
