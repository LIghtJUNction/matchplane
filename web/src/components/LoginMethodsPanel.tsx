"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { SectionHeading } from "./Primitives";

interface LoginMethodStatus {
  emailOtp: boolean;
  phoneOtp: boolean;
  magicLink: boolean;
  passkey: boolean;
  social: string[];
  primary: string[];
}

/**
 * Read-only status board for the mall's sign-in methods. WeChat and SMS
 * credentials deliberately live in deployment environment variables — never in
 * the database or the browser — so this panel reports what the running server
 * has detected and tells the operator exactly which variables complete each
 * method.
 */
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
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as Partial<LoginMethodStatus>;
      setStatus({
        emailOtp: body.emailOtp === true,
        phoneOtp: body.phoneOtp === true,
        magicLink: body.magicLink === true,
        passkey: body.passkey !== false,
        social: Array.isArray(body.social) ? body.social : [],
        primary: Array.isArray(body.primary) ? body.primary : [],
      });
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

  const wechatEnabled = status?.social.includes("wechat") === true;
  const phoneEnabled = status?.phoneOtp === true;

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
        密码和 Passkey 始终可用。微信、手机验证码等方式配置完成后会自动出现在登录页；
        这里显示服务器当前检测到的状态。
      </p>
      {status ? (
        <div className="provider-list" aria-label="登录方式状态">
          <MethodRow
            name="密码"
            detail="邮箱注册账号的默认方式"
            enabled
          />
          <MethodRow
            name="Passkey"
            detail="指纹、面容或安全密钥"
            enabled={status.passkey}
          />
          <MethodRow
            name="微信登录"
            detail={
              wechatEnabled
                ? "已出现在登录页“其他方式”中"
                : "在服务器环境变量中填写微信开放平台凭据"
            }
            enabled={wechatEnabled}
          />
          {!wechatEnabled ? (
            <EnvChecklist
              label="微信登录所需环境变量"
              items={[
                { name: "MATCHPLANE_WECHAT_OAUTH_CLIENT_ID", note: "微信开放平台 AppID" },
                { name: "MATCHPLANE_WECHAT_OAUTH_CLIENT_SECRET", note: "微信开放平台 AppSecret" },
                {
                  name: "MATCHPLANE_WECHAT_OAUTH_AUTHORIZATION_URL / _TOKEN_URL / _USERINFO_URL",
                  note: "三个网关地址需同时填写；支持 OIDC 的网关可只填 MATCHPLANE_WECHAT_OAUTH_DISCOVERY_URL",
                },
                {
                  name: "MATCHPLANE_WECHAT_OAUTH_SCOPES",
                  note: "可选，逗号分隔，默认 snsapi_login（微信开放平台网站扫码登录）",
                },
              ]}
            />
          ) : null}
          <MethodRow
            name="手机号验证码"
            detail={
              phoneEnabled
                ? "登录页支持输入手机号获取短信验证码"
                : "接入一个 HTTPS 短信网关即可开启"
            }
            enabled={phoneEnabled}
          />
          {!phoneEnabled ? (
            <EnvChecklist
              label="手机号验证码所需环境变量"
              items={[
                {
                  name: "MATCHPLANE_SMS_PROVIDER_URL",
                  note: "HTTPS 短信网关地址；服务器会 POST { phoneNumber, code, purpose }",
                },
                {
                  name: "MATCHPLANE_SMS_PROVIDER_TOKEN",
                  note: "可选，作为 Bearer token 随请求发送",
                },
              ]}
            />
          ) : null}
          <MethodRow
            name="邮箱验证码 / 免密链接"
            detail={
              status.emailOtp
                ? "跟随下方“账号邮件”配置，已可用"
                : "在下方“账号邮件”里配置 SMTP 后自动开启"
            }
            enabled={status.emailOtp}
          />
          {status.social.filter((provider) => provider !== "wechat").length ? (
            <MethodRow
              name="其他第三方登录"
              detail={status.social
                .filter((provider) => provider !== "wechat")
                .join("、")}
              enabled
            />
          ) : null}
        </div>
      ) : (
        <p className="subplatform-intro" role={error ? "alert" : "status"}>
          {error ?? "正在检测登录方式…"}
        </p>
      )}
      <div className="login-methods-footer">
        <p>
          修改环境变量后需要重启 Web 服务；登录页最多在 60 秒内更新。QQ、支付宝、Google
          使用相同的 <code>MATCHPLANE_&lt;提供方&gt;_OAUTH_*</code> 变量；
          国家网络身份认证在下方单独配置。
        </p>
        <button
          type="button"
          disabled={checking}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {checking ? "检测中…" : "重新检测"}
        </button>
      </div>
    </section>
  );
}

function MethodRow({
  name,
  detail,
  enabled,
}: {
  name: string;
  detail: string;
  enabled: boolean;
}) {
  return (
    <div className="provider-row login-method-row">
      <span>
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
      <b className={enabled ? "status-chip is-on" : "status-chip"}>
        {enabled ? "已启用" : "未启用"}
      </b>
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
