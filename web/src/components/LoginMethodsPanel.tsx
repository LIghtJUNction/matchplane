"use client";

import { Badge } from "@appica/ui-react/badge";
import { Button } from "@appica/ui-react/button";
import { RefreshCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { SectionHeading } from "./Primitives";

const OAUTH_PROVIDER_IDS = [
  "national_identity",
  "wechat",
  "qq",
  "alipay",
  "google",
] as const;

type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];
type ProviderId =
  | "password"
  | "passkey"
  | "email_otp_magic_link"
  | "phone_otp"
  | OAuthProviderId;

const OAUTH_PROVIDER_SCHEMA = z.enum(OAUTH_PROVIDER_IDS);
const LOGIN_METHOD_STATUS_SCHEMA = z.object({
  password: z.boolean(),
  emailOtp: z.boolean(),
  phoneOtp: z.boolean(),
  magicLink: z.boolean(),
  passkey: z.boolean(),
  social: z.array(OAUTH_PROVIDER_SCHEMA).max(OAUTH_PROVIDER_IDS.length),
  primary: z.array(OAUTH_PROVIDER_SCHEMA).max(OAUTH_PROVIDER_IDS.length),
  oauthCallbacks: z.object({
    national_identity: z.url(),
    wechat: z.url(),
    qq: z.url(),
    alipay: z.url(),
    google: z.url(),
  }),
});

type LoginMethodStatus = z.infer<typeof LOGIN_METHOD_STATUS_SCHEMA>;

interface MethodDefinition {
  id: ProviderId;
  name: string;
  active: string;
  inactive: string;
  environment?: { name: string; note: string }[];
}

const METHODS: MethodDefinition[] = [
  {
    id: "password",
    name: "密码",
    active: "当前 Web 进程内置启用",
    inactive: "当前 Web 进程未启用",
  },
  {
    id: "passkey",
    name: "Passkey",
    active: "当前 Web 进程支持指纹、面容或安全密钥",
    inactive: "当前 Web 进程未启用",
  },
  {
    id: "email_otp_magic_link",
    name: "邮箱验证码 / 免密链接",
    active: "当前 Web 进程已连接可用的账号邮件通道",
    inactive: "当前进程尚未启用；请在下方“账号邮件”面板查看配置",
  },
  {
    id: "phone_otp",
    name: "手机号验证码",
    active: "当前 Web 进程可以投递短信验证码",
    inactive: "当前进程尚未启用；请在下方“短信登录”面板查看配置",
  },
  {
    id: "national_identity",
    name: "国家网络身份认证",
    active: "当前 Web 进程已启用此 OAuth 登录方式",
    inactive: "当前进程尚未启用；请在下方国家网络身份认证面板查看配置",
  },
  {
    id: "wechat",
    name: "微信登录",
    active: "当前 Web 进程已启用此 OAuth 登录方式",
    inactive: "当前进程尚未启用；请在下方微信扫码登录面板查看配置",
  },
  oauthDefinition("qq", "QQ", "QQ"),
  oauthDefinition("alipay", "支付宝", "ALIPAY"),
  oauthDefinition("google", "Google", "GOOGLE"),
];

/** Read-only view of capabilities active in this running Better Auth process. */
export function LoginMethodsPanel() {
  const [status, setStatus] = useState<LoginMethodStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/providers", {
        headers: { accept: "application/json" },
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      setStatus(LOGIN_METHOD_STATUS_SCHEMA.parse(await response.json()));
    } catch {
      setStatus(null);
      setError("登录方式检测失败，请稍后重试。");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section
      className="surface login-methods-panel"
      aria-labelledby="login-methods-title"
    >
      <SectionHeading
        eyebrow="用户登录"
        title="登录方式"
        titleId="login-methods-title"
      />
      <p className="subplatform-intro">
        “已启用”只表示当前运行中的 Web
        进程实际开放该能力，不表示已保存凭据或存在待重启变更。
        微信、国家网络身份、账号邮件和短信的保存状态请以下方各自配置面板为准。
      </p>
      {status ? (
        <div className="provider-list" aria-label="登录方式状态">
          {METHODS.map((method) => {
            const enabled = isEnabled(method.id, status);
            const callbackUrl = isOAuthProvider(method.id)
              ? status.oauthCallbacks[method.id]
              : undefined;
            return (
              <Fragment key={method.id}>
                <MethodRow
                  name={method.name}
                  detail={enabled ? method.active : method.inactive}
                  enabled={enabled}
                  callbackUrl={callbackUrl}
                />
                {!enabled && method.environment ? (
                  <EnvChecklist
                    label={`${method.name}所需环境变量`}
                    items={method.environment}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <p className="subplatform-intro" role={error ? "alert" : "status"}>
          {error ?? "正在检测登录方式…"}
        </p>
      )}
      <div className="login-methods-footer">
        <p>
          QQ、支付宝和 Google 可使用对应的{" "}
          <code>MATCHPLANE_&lt;提供方&gt;_OAUTH_*</code>
          部署变量；变量变更需重启 Web 服务后才会成为当前进程能力。
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={checking}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {checking ? "检测中…" : "重新检测"}
        </Button>
      </div>
    </section>
  );
}

function MethodRow({
  name,
  detail,
  enabled,
  callbackUrl,
}: {
  name: string;
  detail: string;
  enabled: boolean;
  callbackUrl?: string;
}) {
  return (
    <div className="provider-row login-method-row">
      <span>
        <strong>{name}</strong>
        <small>{detail}</small>
        {callbackUrl ? (
          <small>
            回调地址：<code>{callbackUrl}</code>
          </small>
        ) : null}
      </span>
      <Badge size="xs" variant={enabled ? "success" : "outline"}>
        {enabled ? "已启用" : "未启用"}
      </Badge>
    </div>
  );
}

function EnvChecklist({
  label,
  items,
}: {
  label: string;
  items: { name: string; note: string }[];
}) {
  return (
    <div className="login-method-env" aria-label={label}>
      {items.map((item) => (
        <p key={item.name}>
          <code>{item.name}</code>
          <span>{item.note}</span>
        </p>
      ))}
    </div>
  );
}

function oauthDefinition(
  id: OAuthProviderId,
  name: string,
  environmentPrefix: string,
): MethodDefinition {
  const prefix = `MATCHPLANE_${environmentPrefix}_OAUTH_`;
  return {
    id,
    name: `${name} 登录`,
    active: "当前 Web 进程已启用此 OAuth 登录方式",
    inactive: "当前 Web 进程尚未启用；补齐部署变量并重启后生效",
    environment: [
      { name: `${prefix}CLIENT_ID`, note: "提供方分配的 Client ID" },
      { name: `${prefix}CLIENT_SECRET`, note: "通过服务器受保护环境注入" },
      { name: `${prefix}DISCOVERY_URL`, note: "可选的 OIDC discovery 地址" },
      {
        name: `${prefix}AUTHORIZATION_URL`,
        note: "非 discovery 模式需与 token、userinfo 同时填写",
      },
      { name: `${prefix}TOKEN_URL`, note: "OAuth token 端点" },
      { name: `${prefix}USERINFO_URL`, note: "OAuth userinfo 端点" },
    ],
  };
}

function isEnabled(id: ProviderId, status: LoginMethodStatus): boolean {
  if (id === "password") return status.password;
  if (id === "passkey") return status.passkey;
  if (id === "email_otp_magic_link") {
    return status.emailOtp && status.magicLink;
  }
  if (id === "phone_otp") return status.phoneOtp;
  return status.primary.includes(id) || status.social.includes(id);
}

function isOAuthProvider(id: ProviderId): id is OAuthProviderId {
  return OAUTH_PROVIDER_IDS.includes(id as OAuthProviderId);
}
