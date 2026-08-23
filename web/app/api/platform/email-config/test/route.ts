import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { sendRootEmailConfigTest } from "../../../../../src/lib/mail";
import { recordRootEmailConfigTest } from "../../../../../src/lib/root-email-config";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends fixed content only to the verified super administrator who initiated the test. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return NextResponse.json(
      { error: "请求来源未被平台信任" },
      { status: 403 },
    );
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return NextResponse.json({ error: "需要登录" }, { status: 401 });
  const user = session.user as {
    id: string;
    email?: string | null;
    emailVerified?: boolean;
    role?: string | null;
  };
  if (user.role !== "rootSuperAdmin")
    return NextResponse.json(
      { error: "只有超级管理员可以测试根邮箱配置" },
      { status: 403 },
    );
  if (!user.email || user.emailVerified !== true)
    return NextResponse.json(
      { error: "超级管理员邮箱验证完成后即可测试" },
      { status: 409 },
    );
  try {
    await sendRootEmailConfigTest(user.email);
    await recordRootEmailConfigTest(user.id);
    return NextResponse.json(
      { status: "sent" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "测试邮件发送失败" },
      { status: 502 },
    );
  }
}
