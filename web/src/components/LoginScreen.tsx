"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";

import {
  establishMarketplaceSession,
  isLiveMarketplaceEnabled,
  type BetterAuthMarketplaceRole,
} from "../api";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { useInterfacePreferences } from "../lib/preferences";
import { resolveSubplatform, type SubplatformConfig } from "../subplatform";
import { PreferenceControls } from "./PreferenceControls";

type AuthMethod = "password" | "email-otp" | "magic-link";
type SocialProvider = "wechat" | "qq" | "alipay";

const socialLabels: Record<SocialProvider, Record<"zh" | "en", string>> = {
  wechat: { zh: "微信", en: "WeChat" },
  qq: { zh: "QQ", en: "QQ" },
  alipay: { zh: "支付宝", en: "Alipay" },
};

export function LoginScreen() {
  const { theme, locale, setTheme, setLocale } = useInterfacePreferences();
  const copy = loginCopy(locale);
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
      setError(copy.invalidEmail);
      return;
    }
    if (method === "password" && password.length < 8) {
      setError(copy.passwordTooShort);
      return;
    }
    if (method === "email-otp" && otpSent && !/^\d{6}$/.test(otp.trim())) {
      setError(copy.invalidOtp);
      return;
    }
    if (method === "password" && mode === "sign-up" && normalizedName.length < 2) {
      setError(copy.nameRequired);
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (oauthQuery && mode === "sign-up") {
        throw new Error(copy.oauthSignUpBlocked);
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
        setNotice(copy.otpSent);
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
        if (oauthQuery) throw new Error(copy.oauthMagicLinkBlocked);
        const result = await authClient.signIn.magicLink({
          email: normalizedEmail,
          name: normalizedName || undefined,
          callbackURL: next,
          newUserCallbackURL: next,
          errorCallbackURL: `/login?role=${role}&next=${encodeURIComponent(next)}`,
          fetchOptions: options,
        });
        if (result.error) throw new Error(result.error.message || "登录链接发送失败");
        setNotice(copy.magicLinkSent);
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
      if (result.error) throw new Error(result.error.message || copy.authFailed);
      if (mode === "sign-up") {
        setNotice(copy.signUpSent);
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
      setError(cause instanceof Error ? cause.message : copy.authFailed);
      setSubmitting(false);
    }
  };

  const startSocialLogin = async (provider: SocialProvider) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: next,
        errorCallbackURL: `/login?role=${role}&next=${encodeURIComponent(next)}`,
        ...(oauthQuery ? { oauth_query: oauthQuery, additionalData: { query: oauthQuery } } : {}),
        fetchOptions: authFetchOptions(subplatform.slug),
      } as never);
      if (result.error) throw new Error(result.error.message || `${socialLabels[provider][locale]}${copy.socialFailedSuffix}`);
      if (result.data?.url) window.location.assign(result.data.url);
      else throw new Error(copy.socialRedirectMissing);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.socialFailed);
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

  return (
    <main className="login-page">
      <div className="login-topbar">
        <a className="login-back" href="/" aria-label={copy.back}>
          <ArrowLeft size={16} aria-hidden="true" /><span>{copy.back}</span>
        </a>
        <PreferenceControls theme={theme} locale={locale} onThemeChange={setTheme} onLocaleChange={setLocale} />
      </div>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true"><Sparkles size={19} /></div>
        <p className="login-role">{role === "platform" ? copy.rootAdmin : role === "subplatform_admin" ? copy.childAdmin : copy.account}</p>
        <h1 id="login-title">{copy.title}</h1>

        <div className="login-methods" role="tablist" aria-label="登录方式">
          <button className={method === "password" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "password"} onClick={() => switchMethod("password")}>{copy.password}</button>
          <button className={method === "email-otp" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "email-otp"} onClick={() => switchMethod("email-otp")}>{copy.emailOtp}</button>
          <button className={method === "magic-link" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "magic-link"} onClick={() => switchMethod("magic-link")}>{copy.magicLink}</button>
        </div>

        <form className="login-form" onSubmit={submit}>
          {method === "password" && mode === "sign-up" ? (
            <label>
              <span>{copy.name}</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder={copy.namePlaceholder} autoFocus />
            </label>
          ) : null}
          <label htmlFor="login-email"><span>{copy.email}</span><input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" autoFocus={method !== "password" || mode === "sign-in"} /></label>
          {method === "password" ? (
            <label htmlFor="login-password"><span>{copy.password}</span><input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} placeholder={copy.passwordPlaceholder} /></label>
          ) : null}
          {method === "email-otp" && otpSent ? (
            <label htmlFor="login-otp"><span>{copy.otp}</span><input id="login-otp" inputMode="numeric" pattern="[0-9]{6}" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder={copy.otpPlaceholder} /></label>
          ) : null}
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          {notice ? <p className="login-notice" role="status">{notice}</p> : null}
          <button className="button button-dark login-submit" type="submit" disabled={submitting}>
            {submitting ? copy.loading : method === "email-otp" ? (otpSent ? copy.verifyAndContinue : copy.sendOtp) : method === "magic-link" ? copy.sendMagicLink : mode === "sign-in" ? copy.signIn : copy.createAccount}
            {!submitting ? <ArrowRight size={17} aria-hidden="true" /> : null}
          </button>
        </form>

        {method === "password" ? (
          <button className="login-mode-toggle" type="button" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(null); setNotice(null); }}>
            {mode === "sign-in" ? copy.createAccountLink : copy.backToSignIn}
          </button>
        ) : null}

        {socialProviders.length ? (
          <div className="social-login" aria-label="第三方登录">
            <span className="login-divider">{copy.otherMethods}</span>
            <div className="social-login-buttons">
              {socialProviders.map((provider) => (
                <button key={provider} type="button" disabled={submitting} onClick={() => void startSocialLogin(provider)}>
                  <span className={`social-icon social-icon-${provider}`} aria-hidden="true">{provider === "wechat" ? "微" : provider === "qq" ? "Q" : "支"}</span>
                  {socialLabels[provider][locale]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {role === "buyer" ? (
          <a className="login-mode-toggle" href="/login?role=platform&next=%2F%3Frole%3Dplatform">
            {copy.adminLogin}
          </a>
        ) : null}
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

function loginCopy(locale: "zh" | "en") {
  if (locale === "en") {
    return {
      back: "Back",
      rootAdmin: "Root admin",
      childAdmin: "Platform admin",
      account: "MatchPlane",
      title: "Sign in",
      password: "Password",
      emailOtp: "Email code",
      magicLink: "Magic link",
      name: "Name",
      namePlaceholder: "Your name",
      email: "Email",
      passwordPlaceholder: "At least 8 characters",
      otp: "Code",
      otpPlaceholder: "6-digit code",
      loading: "Signing in…",
      verifyAndContinue: "Verify and continue",
      sendOtp: "Send code",
      sendMagicLink: "Send magic link",
      signIn: "Continue",
      createAccount: "Create account",
      createAccountLink: "Create an account",
      backToSignIn: "Back to sign in",
      adminLogin: "Administrator sign-in",
      otherMethods: "Other ways",
      invalidEmail: "Enter a valid email address.",
      passwordTooShort: "Password must be at least 8 characters.",
      invalidOtp: "Enter the 6-digit code.",
      nameRequired: "Enter your name.",
      oauthSignUpBlocked: "Create and verify your account before authorizing a platform.",
      oauthMagicLinkBlocked: "Use a password or email code for platform authorization.",
      otpSent: "Code sent.",
      magicLinkSent: "Magic link sent.",
      signUpSent: "Check your email to verify your account.",
      authFailed: "Sign-in did not complete. Try again.",
      socialFailedSuffix: " sign-in failed",
      socialRedirectMissing: "The sign-in provider did not return a redirect.",
      socialFailed: "Social sign-in is unavailable.",
    };
  }
  return {
    back: "返回",
    rootAdmin: "根平台管理",
    childAdmin: "子平台管理",
    account: "MatchPlane",
    title: "登录",
    password: "密码",
    emailOtp: "邮箱验证码",
    magicLink: "免密链接",
    name: "称呼",
    namePlaceholder: "你的称呼",
    email: "邮箱",
    passwordPlaceholder: "至少 8 位",
    otp: "验证码",
    otpPlaceholder: "6 位验证码",
    loading: "正在登录…",
    verifyAndContinue: "验证并继续",
    sendOtp: "发送验证码",
    sendMagicLink: "发送免密链接",
    signIn: "继续",
    createAccount: "创建账号",
    createAccountLink: "创建账号",
    backToSignIn: "返回登录",
    adminLogin: "管理员登录",
    otherMethods: "其他方式",
    invalidEmail: "请输入有效的邮箱地址。",
    passwordTooShort: "密码至少需要 8 位。",
    invalidOtp: "请输入 6 位验证码。",
    nameRequired: "请输入你的称呼。",
    oauthSignUpBlocked: "请先创建并验证账号，再进行平台授权。",
    oauthMagicLinkBlocked: "平台授权请使用密码或邮箱验证码。",
    otpSent: "验证码已发送。",
    magicLinkSent: "免密链接已发送。",
    signUpSent: "请查收邮件并完成验证。",
    authFailed: "登录没有完成，请再试一次。",
    socialFailedSuffix: "登录失败",
    socialRedirectMissing: "登录服务没有返回跳转地址。",
    socialFailed: "第三方登录暂时不可用。",
  };
}
