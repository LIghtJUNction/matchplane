import { NextResponse } from "next/server";

import {
  auth,
  authBaseURL,
  configuredOAuthProviderIds,
} from "../../../../src/lib/auth";
import { isPhoneOtpConfigured } from "../../../../src/lib/sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRootAdmin(role: unknown): boolean {
  return role === "rootSuperAdmin" || role === "rootAdmin";
}

// Better Auth's generic-oauth plugin routes every provider through the core
// `callback/:id` endpoint, so the operator-facing callback URL must come from
// the server-configured base URL — never from the request's Origin header.
function oauthCallbackUrl(providerId: string): string {
  return `${authBaseURL}/api/auth/callback/${providerId}`;
}

export async function GET(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session?.user?.id || !isRootAdmin(role)) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }

  // Reuse Better Auth's own provider capability helpers so the panel reflects
  // exactly what the auth service would activate: client ID + secret + a
  // complete endpoint contract, with managed enable/disable records winning
  // over deployment variables.
  const activeProviders = new Set(configuredOAuthProviderIds());
  const phone = isPhoneOtpConfigured();

  const oauthHint =
    "需 Client ID、Client Secret 与完整端点契约（discovery 或 authorization/token/userinfo）齐备后才启用";

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
        configured: phone,
        enabled: phone,
        envKeys: ["MATCHPLANE_SMS_PROVIDER_URL"],
        hint: "短信网关 POST 接口；验证码由 Better Auth 生成，网关只负责投递",
      },
      {
        id: "wechat",
        label: "微信 OAuth",
        configured: activeProviders.has("wechat"),
        enabled: activeProviders.has("wechat"),
        envKeys: [
          "MATCHPLANE_WECHAT_OAUTH_CLIENT_ID",
          "MATCHPLANE_WECHAT_OAUTH_CLIENT_SECRET",
          "MATCHPLANE_WECHAT_OAUTH_DISCOVERY_URL（或 AUTHORIZATION_URL/TOKEN_URL/USERINFO_URL）",
        ],
        callbackUrl: oauthCallbackUrl("wechat"),
        hint: "在微信开放平台配置上述回调 URL；需认证过的服务号/开放平台账号",
      },
      {
        id: "google",
        label: "Google OAuth",
        configured: activeProviders.has("google"),
        enabled: activeProviders.has("google"),
        envKeys: [
          "MATCHPLANE_GOOGLE_OAUTH_CLIENT_ID",
          "MATCHPLANE_GOOGLE_OAUTH_CLIENT_SECRET",
          "MATCHPLANE_GOOGLE_OAUTH_DISCOVERY_URL（或 AUTHORIZATION_URL/TOKEN_URL/USERINFO_URL）",
        ],
        callbackUrl: oauthCallbackUrl("google"),
        hint: oauthHint,
      },
      {
        id: "qq",
        label: "QQ OAuth",
        configured: activeProviders.has("qq"),
        enabled: activeProviders.has("qq"),
        envKeys: [
          "MATCHPLANE_QQ_OAUTH_CLIENT_ID",
          "MATCHPLANE_QQ_OAUTH_CLIENT_SECRET",
          "MATCHPLANE_QQ_OAUTH_DISCOVERY_URL（或 AUTHORIZATION_URL/TOKEN_URL/USERINFO_URL）",
        ],
        callbackUrl: oauthCallbackUrl("qq"),
        hint: oauthHint,
      },
      {
        id: "alipay",
        label: "支付宝 OAuth",
        configured: activeProviders.has("alipay"),
        enabled: activeProviders.has("alipay"),
        envKeys: [
          "MATCHPLANE_ALIPAY_OAUTH_CLIENT_ID",
          "MATCHPLANE_ALIPAY_OAUTH_CLIENT_SECRET",
          "MATCHPLANE_ALIPAY_OAUTH_DISCOVERY_URL（或 AUTHORIZATION_URL/TOKEN_URL/USERINFO_URL）",
        ],
        callbackUrl: oauthCallbackUrl("alipay"),
        hint: oauthHint,
      },
      {
        id: "nationalIdentity",
        label: "实名认证",
        configured: activeProviders.has("national_identity"),
        enabled: activeProviders.has("national_identity"),
        envKeys: [
          "MATCHPLANE_NATIONAL_IDENTITY_OAUTH_CLIENT_ID",
          "MATCHPLANE_NATIONAL_IDENTITY_OAUTH_CLIENT_SECRET",
          "MATCHPLANE_NATIONAL_IDENTITY_OAUTH_DISCOVERY_URL（或 AUTHORIZATION_URL/TOKEN_URL/USERINFO_URL）",
        ],
        hint: oauthHint,
      },
    ],
  });
}
