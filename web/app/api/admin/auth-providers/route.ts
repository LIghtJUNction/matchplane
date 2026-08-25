import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRootAdmin(role: unknown): boolean {
  return role === "rootSuperAdmin" || role === "rootAdmin";
}

export async function GET(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session?.user?.id || !isRootAdmin(role)) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }

  const sms = Boolean(process.env.MATCHPLANE_SMS_PROVIDER_URL?.trim());
  const wechat = Boolean(process.env.MATCHPLANE_WECHAT_OAUTH_CLIENT_ID?.trim());
  const google = Boolean(process.env.MATCHPLANE_GOOGLE_OAUTH_CLIENT_ID?.trim());
  const qq = Boolean(process.env.MATCHPLANE_QQ_OAUTH_CLIENT_ID?.trim());
  const alipay = Boolean(process.env.MATCHPLANE_ALIPAY_OAUTH_CLIENT_ID?.trim());
  const nationalIdentity = Boolean(process.env.MATCHPLANE_NATIONAL_IDENTITY_OAUTH_CLIENT_ID?.trim());

  return NextResponse.json({
    providers: [
      {
        id: "email",
        label: "邮箱",
        configured: true,
        enabled: true,
        hint: "内置 Better Auth 邮箱验证，默认开启",
      },
      {
        id: "phone",
        label: "手机号 OTP",
        configured: sms,
        enabled: sms,
        hint: "MATCHPLANE_SMS_PROVIDER_URL 指向短信网关 POST 接口；验证码由 Better Auth 生成，网关只负责投递",
      },
      {
        id: "wechat",
        label: "微信 OAuth",
        configured: wechat,
        enabled: wechat,
        envKeys: ["MATCHPLANE_WECHAT_OAUTH_CLIENT_ID", "MATCHPLANE_WECHAT_OAUTH_CLIENT_SECRET"],
        callbackUrl: `${request.headers.get("origin") || "http://127.0.0.1:4173"}/api/auth/callback/wechat`,
        hint: "在微信开放平台配置上述回调 URL；需认证过的服务号/开放平台账号",
      },
      {
        id: "google",
        label: "Google OAuth",
        configured: google,
        enabled: google,
        callbackUrl: `${request.headers.get("origin") || "http://127.0.0.1:4173"}/api/auth/callback/google`,
      },
      {
        id: "qq",
        label: "QQ OAuth",
        configured: qq,
        enabled: qq,
        callbackUrl: `${request.headers.get("origin") || "http://127.0.0.1:4173"}/api/auth/callback/qq`,
      },
      {
        id: "alipay",
        label: "支付宝 OAuth",
        configured: alipay,
        enabled: alipay,
        callbackUrl: `${request.headers.get("origin") || "http://127.0.0.1:4173"}/api/auth/callback/alipay`,
      },
      {
        id: "nationalIdentity",
        label: "实名认证",
        configured: nationalIdentity,
        enabled: nationalIdentity,
        hint: "可选国家网络身份认证适配器",
      },
    ],
  });
}
