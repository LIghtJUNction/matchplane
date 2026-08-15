"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, KeyRound, LockKeyhole, Sparkles } from "lucide-react";

import {
  establishMarketplaceSession,
  isLiveMarketplaceEnabled,
  type BetterAuthMarketplaceRole,
} from "../api";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { resolveSubplatform, type SubplatformConfig } from "../subplatform";

type AuthMethod = "password" | "email-otp" | "magic-link";
type SocialProvider = "wechat" | "qq" | "alipay";

const socialLabels: Record<SocialProvider, string> = {
  wechat: "微信",
  qq: "QQ",
  alipay: "支付宝",
};

export function LoginScreen() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [method, setMethod] = useState<AuthMethod>("password");
  const [next, setNext] = useState("/");
  const [oauthQuery, setOauthQuery] = useState<string | null>(null);
  const [role, setRole] = useState<BetterAuthMarketplaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() => resolveSubplatform());
  const [socialProviders, setSocialProviders] = useState<SocialProvider[]>([]);
  const [otpSent, setOtpSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signedOAuthQuery = params.has("sig") && params.has("client_id") && params.has("redirect_uri")
      ? params.toString()
      : null;
    setOauthQuery(signedOAuthQuery);
    const requestedRole = params.get("role");
    setRole(
      requestedRole === "seller"
        ? "seller"
        : requestedRole === "platform"
          ? "platform"
          : requestedRole === "subplatform_admin" || requestedRole === "admin"
            ? "subplatform_admin"
            : "buyer",
    );
    const nextPath = safeNext(params.get("next"));
    setNext(nextPath);
    setSubplatform(resolveSubplatform(nextPath));
    void fetch("/api/auth/providers", { headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<{ social?: string[] }> : null)
      .then((providers) => {
        const configured = new Set(providers?.social ?? []);
        setSocialProviders(["wechat", "qq", "alipay"].filter((provider): provider is SocialProvider => configured.has(provider)));
      })
      .catch(() => setSocialProviders([]));
  }, []);

  const finishSignIn = async () => {
    if (isLiveMarketplaceEnabled() && role !== "platform") {
      if (!subplatform.tenantId) throw new Error("当前子平台尚未完成 root tenant 注册");
      const current = await authClient.getSession({
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (current.error || !current.data) throw new Error("Better Auth 会话尚未建立");
      await establishMarketplaceSession({
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        role,
        authUserId: current.data.user.id,
      });
    }
    window.location.assign(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = displayName.trim();
    if (!isEmail(normalizedEmail)) {
      setError("请输入有效的邮箱地址。");
      return;
    }
    if (method === "password" && password.length < 8) {
      setError("密码至少需要 8 位，由 Better Auth 负责安全存储和验证。");
      return;
    }
    if (method === "email-otp" && otpSent && !/^\d{6}$/.test(otp.trim())) {
      setError("请输入 6 位邮箱验证码。");
      return;
    }
    if (method === "password" && mode === "sign-up" && normalizedName.length < 2) {
      setError("请先留下一个称呼，方便匹配双方识别彼此。");
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (oauthQuery && mode === "sign-up") {
        throw new Error("请先创建并验证账号，再从子平台重新发起统一登录授权");
      }
      const options = authFetchOptions(subplatform.slug);
      if (method === "email-otp" && !otpSent) {
        const result = await authClient.emailOtp.sendVerificationOtp({
          email: normalizedEmail,
          type: "sign-in",
          fetchOptions: options,
        });
        if (result.error) throw new Error(result.error.message || "验证码发送失败");
        setOtpSent(true);
        setNotice("验证码已发送到你的邮箱，5 分钟内有效。");
        setSubmitting(false);
        return;
      }
      if (method === "email-otp") {
        const result = await authClient.signIn.emailOtp({
          email: normalizedEmail,
          otp: otp.trim(),
          name: normalizedName || undefined,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
          fetchOptions: options,
        } as never);
        if (result.error) throw new Error(result.error.message || "验证码登录失败");
        const oauthRedirect = oauthRedirectUrl(result.data);
        if (oauthQuery && oauthRedirect) {
          window.location.assign(oauthRedirect);
          return;
        }
        await finishSignIn();
        return;
      }
      if (method === "magic-link") {
        if (oauthQuery) throw new Error("跨域统一登录请使用密码或邮箱验证码，免密链接暂不支持授权回调");
        const result = await authClient.signIn.magicLink({
          email: normalizedEmail,
          name: normalizedName || undefined,
          callbackURL: next,
          newUserCallbackURL: next,
          errorCallbackURL: `/login?role=${role}&next=${encodeURIComponent(next)}`,
          fetchOptions: options,
        });
        if (result.error) throw new Error(result.error.message || "登录链接发送失败");
        setNotice("登录链接已发送。请打开邮件中的链接，平台会自动回到刚才的页面。");
        setSubmitting(false);
        return;
      }

      const result = mode === "sign-up"
        ? await authClient.signUp.email({
            name: normalizedName,
            email: normalizedEmail,
            password,
            callbackURL: next,
            fetchOptions: options,
          })
        : await authClient.signIn.email({
            email: normalizedEmail,
            password,
            callbackURL: next,
            ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
            fetchOptions: options,
          } as never);
      if (result.error) throw new Error(result.error.message || "Better Auth 未完成登录");
      if (mode === "sign-up") {
        setNotice("验证邮件已由 Better Auth 发出。完成邮箱验证后，用同一个账号登录所有已开放的子平台。");
        setSubmitting(false);
        return;
      }
      const oauthRedirect = oauthRedirectUrl(result.data);
      if (oauthQuery && oauthRedirect) {
        window.location.assign(oauthRedirect);
        return;
      }
      await finishSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Better Auth 登录暂时没有完成，请稍后再试。");
      setSubmitting(false);
    }
  };

  const startSocialLogin = async (provider: SocialProvider) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.signIn.oauth2({
        providerId: provider,
        callbackURL: next,
        errorCallbackURL: `/login?role=${role}&next=${encodeURIComponent(next)}`,
        ...(oauthQuery ? { oauth_query: oauthQuery, additionalData: { query: oauthQuery } } : {}),
        fetchOptions: authFetchOptions(subplatform.slug),
      } as never);
      if (result.error) throw new Error(result.error.message || `${socialLabels[provider]}登录未完成`);
      if (result.data?.url) window.location.assign(result.data.url);
      else throw new Error("登录服务没有返回跳转地址");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "第三方登录暂时不可用");
      setSubmitting(false);
    }
  };

  const switchMethod = (nextMethod: AuthMethod) => {
    setMethod(nextMethod);
    setOtpSent(false);
    setOtp("");
    setError(null);
    setNotice(null);
    if (nextMethod !== "password") setMode("sign-in");
  };

  const rootAdminHref = `/login?role=platform&next=${encodeURIComponent("/?role=platform")}`;
  const childAdminHref = subplatform.slug === "root"
    ? null
    : `/login?role=subplatform_admin&next=${encodeURIComponent(`${subplatform.path}?role=subplatform_admin`)}`;

  return (
    <main className="login-page">
      <a className="login-back" href="/">
        <ArrowLeft size={16} aria-hidden="true" /> 返回 MatchPlane
      </a>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true"><Sparkles size={19} /></div>
        <span className="eyebrow">Better Auth · {role === "platform" ? "根平台管理员入口" : role === "subplatform_admin" ? "子平台管理员入口" : "统一身份登录"}</span>
        <h1 id="login-title">一个账号，<br />继续你的匹配。</h1>
        <p className="login-intro">登录一次即可访问已开放的根平台和子平台。每个平台只会授予自己的成员权限，管理员权限仍需平台邀请。</p>

        <div className="login-methods" role="tablist" aria-label="登录方式">
          <button className={method === "password" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "password"} onClick={() => switchMethod("password")}>密码</button>
          <button className={method === "email-otp" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "email-otp"} onClick={() => switchMethod("email-otp")}>邮箱验证码</button>
          <button className={method === "magic-link" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "magic-link"} onClick={() => switchMethod("magic-link")}>免密链接</button>
        </div>

        <form className="login-form" onSubmit={submit}>
          {method === "password" && mode === "sign-up" ? (
            <label>
              <span>怎么称呼你</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder="例如：林先生 / Mira" autoFocus />
            </label>
          ) : null}
          <label htmlFor="login-email"><span>邮箱地址</span><input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" autoFocus={method !== "password" || mode === "sign-in"} /></label>
          {method === "password" ? (
            <label htmlFor="login-password"><span>密码</span><input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} placeholder="至少 8 位" /></label>
          ) : null}
          {method === "email-otp" && otpSent ? (
            <label htmlFor="login-otp"><span>6 位验证码</span><input id="login-otp" inputMode="numeric" pattern="[0-9]{6}" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder="输入邮件中的验证码" /></label>
          ) : null}
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          {notice ? <p className="login-notice" role="status">{notice}</p> : null}
          <button className="button button-dark login-submit" type="submit" disabled={submitting}>
            {submitting ? "Better Auth 处理中…" : method === "email-otp" ? (otpSent ? "验证并继续" : "发送验证码") : method === "magic-link" ? "发送免密链接" : mode === "sign-in" ? "登录并继续" : "创建并验证邮箱"}
            {!submitting ? <ArrowRight size={17} aria-hidden="true" /> : null}
          </button>
        </form>

        {method === "password" ? (
          <button className="login-mode-toggle" type="button" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(null); setNotice(null); }}>
            {mode === "sign-in" ? "还没有账号？创建一个" : "已经有账号？返回登录"}
          </button>
        ) : null}

        {socialProviders.length ? (
          <div className="social-login" aria-label="第三方登录">
            <span className="login-divider">或使用已配置的第三方账号</span>
            <div className="social-login-buttons">
              {socialProviders.map((provider) => (
                <button key={provider} type="button" disabled={submitting} onClick={() => void startSocialLogin(provider)}>
                  <span className={`social-icon social-icon-${provider}`} aria-hidden="true">{provider === "wechat" ? "微" : provider === "qq" ? "Q" : "支"}</span>
                  {socialLabels[provider]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="login-provider-note"><KeyRound size={14} aria-hidden="true" /> 微信、QQ、支付宝登录已预留；由平台管理员配置后才会显示。</p>
        )}

        <div className="login-admin-entry" aria-label="管理员入口">
          <span>管理员入口</span>
          <a href={rootAdminHref}>{role === "platform" ? "当前为根平台管理员" : "根平台管理员登录"}</a>
          {childAdminHref ? <a href={childAdminHref}>子平台管理员登录</a> : null}
        </div>
        <p className="login-privacy"><LockKeyhole size={14} aria-hidden="true" /> 联系方式加密保存，撮合前不会展示给对方。</p>
      </section>
    </main>
  );
}

function oauthRedirectUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const url = (value as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const resolved = new URL(value, window.location.origin);
    return resolved.origin === window.location.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : "/";
  } catch {
    return "/";
  }
}
