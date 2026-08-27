"use client";

import { Button } from "@appica/ui-react/button";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useSearchParams } from "next/navigation";

const SCOPE_LABELS: Record<string, string> = {
  openid: "确认你的统一身份",
  profile: "读取基本称呼与头像",
  email: "读取已验证的邮箱状态",
};

export function OAuthConsentScreen() {
  const params = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Better Auth signs the complete query string when it redirects here.  Do not
  // reconstruct or trust individual parameters: forwarding the exact signed
  // string lets the provider verify state, expiry and redirect_uri server-side.
  const oauthQuery = params.get("oauth_query") ?? params.toString();
  const clientId = params.get("client_id") ?? "外部店铺";
  const scopes = useMemo(
    () =>
      (params.get("scope") ?? "openid")
        .split(" ")
        .map((scope) => scope.trim())
        .filter(Boolean),
    [params],
  );

  const decide = async (accept: boolean) => {
    if (!oauthQuery || submitting) {
      setError("授权请求已失效，请从店铺重新发起登录。 ");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      let body: { url?: string; error?: string } | null;
      try {
        body = (await response.json()) as { url?: string; error?: string };
      } catch {
        body = null;
      }
      if (!response.ok || !body?.url)
        throw new Error(body?.error || "授权服务没有返回继续地址");
      window.location.assign(body.url);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "授权暂时没有完成，请稍后重试。",
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <a className="login-back" href="/">
        <ArrowLeft size={16} aria-hidden="true" /> 返回 MatchPlane
      </a>
      <section
        className="login-card oauth-consent-card"
        aria-labelledby="oauth-consent-title"
      >
        <div className="login-mark" aria-hidden="true">
          <Sparkles size={19} />
        </div>
        <span className="eyebrow">
          <LockKeyhole size={14} aria-hidden="true" /> 跨域统一身份授权
        </span>
        <h1 id="oauth-consent-title">确认继续到店铺</h1>
        <p className="login-intro">
          <strong>{clientId}</strong>{" "}
          请求使用你的商城统一身份。店铺只会获得下方明确列出的资料，
          不会获得密码、支付信息、联系方式或其他平台的管理权限。
        </p>
        <ul className="oauth-consent-scopes" aria-label="授权范围">
          {scopes.map((scope) => (
            <li key={scope}>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>{SCOPE_LABELS[scope] ?? `授权范围：${scope}`}</span>
            </li>
          ))}
        </ul>
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="oauth-consent-actions">
          <Button
            variant="soft"
            size="md"
            className="min-h-11"
            type="button"
            disabled={submitting}
            onClick={() => void decide(false)}
          >
            拒绝
          </Button>
          <Button
            variant="primary"
            size="md"
            className="min-h-11"
            type="button"
            disabled={submitting}
            onClick={() => void decide(true)}
          >
            {submitting ? "正在继续…" : "同意并继续"}
            {submitting ? null : <ArrowRight size={17} aria-hidden="true" />}
          </Button>
        </div>
        <p className="login-footnote">
          授权可随时在商城账户页撤销；店铺会话也会在短期内失效。
        </p>
      </section>
    </main>
  );
}
