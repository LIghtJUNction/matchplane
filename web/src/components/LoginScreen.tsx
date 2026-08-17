"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Fingerprint, KeyRound, QrCode, X } from "lucide-react";

import {
  establishMarketplaceSession,
  isLiveMarketplaceEnabled,
  redeemPlatformAdminInvite,
  type BetterAuthMarketplaceRole,
} from "../api";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { useInterfacePreferences } from "../lib/preferences";
import { loadSubplatform, resolveSubplatform, type SubplatformConfig } from "../subplatform";
import { PreferenceControls } from "./PreferenceControls";

type AuthMethod = "password" | "email-otp" | "magic-link";
type SocialProvider = "google" | "wechat" | "qq" | "alipay";
type OAuthProvider = SocialProvider | "national_identity";

interface AuthCapabilities {
  emailOtp: boolean;
  phoneOtp: boolean;
  magicLink: boolean;
  passkey: boolean;
}

const socialLabels: Record<SocialProvider, Record<"zh" | "en", string>> = {
  google: { zh: "Google", en: "Google" },
  wechat: { zh: "微信", en: "WeChat" },
  qq: { zh: "QQ", en: "QQ" },
  alipay: { zh: "支付宝", en: "Alipay" },
};

export function LoginScreen() {
  const { theme, locale, setTheme, setLocale } = useInterfacePreferences();
  const copy = loginCopy(locale);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [method, setMethod] = useState<AuthMethod>("password");
  const [next, setNext] = useState("/");
  const [oauthQuery, setOauthQuery] = useState<string | null>(null);
  const [adminInviteToken, setAdminInviteToken] = useState<string | null>(null);
  const [role, setRole] = useState<BetterAuthMarketplaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() => resolveSubplatform());
  const [socialProviders, setSocialProviders] = useState<SocialProvider[]>([]);
  const [nationalIdentityEnabled, setNationalIdentityEnabled] = useState(false);
  const [capabilities, setCapabilities] = useState<AuthCapabilities>({
    // Password remains the deployment-independent fallback. Other methods are hidden until
    // the server confirms that their delivery/credential adapter is configured.
    emailOtp: false,
    phoneOtp: false,
    magicLink: false,
    passkey: true,
  });
  const [otpSent, setOtpSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const redeemingInviteRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signedOAuthQuery = params.has("sig") && params.has("client_id") && params.has("redirect_uri")
      ? params.toString()
      : null;
    setOauthQuery(signedOAuthQuery);
    const invite = params.get("token") || params.get("admin_invite");
    const inviteToken = invite && /^mpa_[0-9a-f]{64}$/.test(invite) ? invite : null;
    setAdminInviteToken(inviteToken);
    const requestedRole = params.get("role");
    setRole(
      inviteToken
        ? "platform"
        : requestedRole === "seller"
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
    // The path-only config is intentionally used for the first paint, but the
    // capability exchange after login needs the server-owned tenant/domain
    // scope. Hydrate the same manifest/setup data that App uses before
    // finishSignIn runs; otherwise a successful production login would stop at
    // "root tenant not configured" and the pending chat could not continue.
    let cancelled = false;
    void loadSubplatform(nextPath).then((loaded) => {
      if (!cancelled) setSubplatform(loaded);
    });
    void fetch("/api/auth/providers", { headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<{
        primary?: string[];
        social?: string[];
        emailOtp?: boolean;
        phoneOtp?: boolean;
        magicLink?: boolean;
        passkey?: boolean;
      }> : null)
      .then((providers) => {
        const configured = new Set(providers?.social ?? []);
        setNationalIdentityEnabled((providers?.primary ?? []).includes("national_identity"));
        setSocialProviders(["google", "wechat", "qq", "alipay"].filter((provider): provider is SocialProvider => configured.has(provider)));
        setCapabilities({
          emailOtp: providers?.emailOtp === true,
          phoneOtp: providers?.phoneOtp === true,
          magicLink: providers?.magicLink === true,
          passkey: providers?.passkey !== false,
        });
      })
      .catch(() => {
        setNationalIdentityEnabled(false);
        setSocialProviders([]);
        setCapabilities({ emailOtp: false, phoneOtp: false, magicLink: false, passkey: true });
      });
    return () => {
      cancelled = true;
      };
  }, []);

  useEffect(() => {
    if (!adminInviteToken || redeemingInviteRef.current) return;
    let cancelled = false;
    void authClient.getSession({ fetchOptions: authFetchOptions(subplatform.slug) })
      .then(async ({ data }) => {
        if (cancelled || !data?.user) return;
        redeemingInviteRef.current = true;
        try {
          await redeemPlatformAdminInvite(adminInviteToken);
          if (cancelled) return;
          setAdminInviteToken(null);
          window.location.assign(next);
        } catch (cause) {
          redeemingInviteRef.current = false;
          if (!cancelled) setError(cause instanceof Error ? cause.message : copy.authFailed);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [adminInviteToken, copy.authFailed, next, subplatform.slug]);

  const finishSignIn = async () => {
    // The user can submit before the background manifest fetch completes. Do a
    // final synchronous-in-flow load so the capability exchange never uses the
    // path-only placeholder config.
    let targetSubplatform = subplatform;
    if (isLiveMarketplaceEnabled() && role !== "platform" && !targetSubplatform.tenantId) {
      targetSubplatform = await loadSubplatform(next);
      setSubplatform(targetSubplatform);
    }
    if (isLiveMarketplaceEnabled() && role !== "platform") {
      if (!targetSubplatform.tenantId) throw new Error("当前子平台尚未完成 root tenant 注册");
      const current = await authClient.getSession({
        fetchOptions: authFetchOptions(targetSubplatform.slug),
      });
      if (current.error || !current.data) throw new Error("Better Auth 会话尚未建立");
      await establishMarketplaceSession({
        tenantId: targetSubplatform.tenantId,
        domainId: targetSubplatform.domainId,
        subplatform: targetSubplatform.slug,
        platformPath: targetSubplatform.path,
        role,
        authUserId: current.data.user.id,
      });
    }
    if (adminInviteToken) {
      if (!redeemingInviteRef.current) {
        redeemingInviteRef.current = true;
        try {
          await redeemPlatformAdminInvite(adminInviteToken);
        } catch (cause) {
          redeemingInviteRef.current = false;
          throw cause;
        }
      }
      setAdminInviteToken(null);
    }
    window.location.assign(next);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resolvedIdentifier = resolveIdentifier(identifier);
    if (!resolvedIdentifier) {
      setError(copy.invalidIdentifier);
      return;
    }
    if (method === "password" && resolvedIdentifier.kind === "phone") {
      setError(copy.phonePasswordUnavailable);
      return;
    }
    if (method === "email-otp" && resolvedIdentifier.kind === "email" && !capabilities.emailOtp) {
      setError(copy.emailOtpUnavailable);
      return;
    }
    if (method === "email-otp" && resolvedIdentifier.kind === "phone" && !capabilities.phoneOtp) {
      setError(copy.phoneOtpUnavailable);
      return;
    }
    if (method === "magic-link" && resolvedIdentifier.kind === "phone") {
      setError(copy.phoneMagicLinkUnavailable);
      return;
    }
    if (method === "magic-link" && !capabilities.magicLink) {
      setError(copy.magicLinkUnavailable);
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
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const options = authFetchOptions(subplatform.slug);
      if (method === "email-otp" && !otpSent) {
        const result = resolvedIdentifier.kind === "phone"
          ? await authClient.phoneNumber.sendOtp({
              phoneNumber: resolvedIdentifier.value,
              fetchOptions: options,
            })
          : await authClient.emailOtp.sendVerificationOtp({
              email: resolvedIdentifier.value,
              type: "sign-in",
              fetchOptions: options,
            });
        if (result.error) throw new Error(result.error.message || "验证码发送失败");
        setOtpSent(true);
        setNotice(resolvedIdentifier.kind === "phone" ? copy.phoneOtpSent : copy.otpSent);
        setSubmitting(false);
        return;
      }
      if (method === "email-otp") {
        const result = resolvedIdentifier.kind === "phone"
          ? await authClient.phoneNumber.verify({
              phoneNumber: resolvedIdentifier.value,
              code: otp.trim(),
              fetchOptions: options,
            } as never)
          : await authClient.signIn.emailOtp({
              email: resolvedIdentifier.value,
              otp: otp.trim(),
              ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
              fetchOptions: options,
            } as never);
        if (result.error) throw new Error(result.error.message || "验证码登录失败");
        const oauthRedirect = resolvedIdentifier.kind === "email" ? oauthRedirectUrl(result.data) : null;
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
          email: resolvedIdentifier.value,
          callbackURL: authCallbackURL(next, adminInviteToken),
          newUserCallbackURL: authCallbackURL(next, adminInviteToken),
          errorCallbackURL: authErrorCallbackURL(role, next, adminInviteToken),
          fetchOptions: options,
        });
        if (result.error) throw new Error(result.error.message || "登录链接发送失败");
        setNotice(copy.magicLinkSent);
        setSubmitting(false);
        return;
      }

      const result = await authClient.signIn.email({
        email: resolvedIdentifier.value,
        password,
        callbackURL: authCallbackURL(next, adminInviteToken),
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        fetchOptions: options,
      } as never);
      if (result.error) {
        if (oauthQuery) throw new Error(copy.authFailed);
        // One neutral action handles both returning and first-time users. A
        // failed sign-in is followed by an idempotent sign-up attempt: an
        // existing account remains untouched, while a new account receives
        // the normal Better Auth verification email.
        const created = await authClient.signUp.email({
          name: displayNameFromIdentifier(resolvedIdentifier.value),
          email: resolvedIdentifier.value,
          password,
          callbackURL: authCallbackURL(next, adminInviteToken),
          fetchOptions: options,
        });
        if (!created.error) {
          setNotice(copy.signUpSent);
          setSubmitting(false);
          return;
        }
        throw new Error(copy.authFailed);
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

  const startSocialLogin = async (provider: OAuthProvider) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: authCallbackURL(next, adminInviteToken),
        errorCallbackURL: authErrorCallbackURL(role, next, adminInviteToken),
        ...(oauthQuery ? { oauth_query: oauthQuery, additionalData: { query: oauthQuery } } : {}),
        fetchOptions: authFetchOptions(subplatform.slug),
      } as never);
      const providerLabel = provider === "national_identity" ? copy.nationalIdentity : socialLabels[provider][locale];
      if (result.error) throw new Error(result.error.message || `${providerLabel}${copy.socialFailedSuffix}`);
      if (result.data?.url) window.location.assign(result.data.url);
      else throw new Error(copy.socialRedirectMissing);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.socialFailed);
      setSubmitting(false);
    }
  };

  const startPasskeyLogin = async () => {
    if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) {
      setNotice(copy.passkeyUnsupported);
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await authClient.signIn.passkey({
        autoFill: false,
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (result.error) throw new Error(result.error.message || copy.passkeyFailed);
      await finishSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.passkeyFailed);
      setSubmitting(false);
    }
  };

  const switchMethod = (nextMethod: AuthMethod) => {
    setMethod(nextMethod);
    setOtpSent(false);
    setOtp("");
    setError(null);
    setNotice(null);
  };

  const availableMethods: AuthMethod[] = [
    "password",
    ...(capabilities.emailOtp || capabilities.phoneOtp ? ["email-otp" as const] : []),
    ...(capabilities.magicLink ? ["magic-link" as const] : []),
  ];

  return (
    <main className="login-page">
      <div className="login-topbar">
        <a className="login-back" href="/" aria-label={copy.back}>
          <ArrowLeft size={16} aria-hidden="true" /><span>{copy.back}</span>
        </a>
        <PreferenceControls theme={theme} locale={locale} onThemeChange={setTheme} onLocaleChange={setLocale} />
      </div>
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title" className="sr-only">{copy.account}</h1>
        <button className="login-qr-corner" type="button" onClick={() => setQrOpen(true)} aria-label={copy.qrLogin}>
          <span className="login-qr-corner-mark" aria-hidden="true"><QrCode size={22} strokeWidth={1.7} /></span>
          <span>{copy.qrLogin}</span>
        </button>

        {nationalIdentityEnabled ? (
          <div className="login-primary-provider">
            <button type="button" disabled={submitting} onClick={() => void startSocialLogin("national_identity")}>
              <Fingerprint size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.nationalIdentity}</span>
            </button>
          </div>
        ) : null}

        <div className={`login-methods login-methods-count-${availableMethods.length}`} role="tablist" aria-label={copy.authMethods}>
          <button className={method === "password" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "password"} onClick={() => switchMethod("password")}>{copy.password}</button>
          {availableMethods.includes("email-otp") ? <button className={method === "email-otp" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "email-otp"} onClick={() => switchMethod("email-otp")}>{copy.emailOtp}</button> : null}
          {availableMethods.includes("magic-link") ? <button className={method === "magic-link" ? "is-active" : ""} type="button" role="tab" aria-selected={method === "magic-link"} onClick={() => switchMethod("magic-link")}>{copy.magicLink}</button> : null}
        </div>

        <form className="login-form" onSubmit={submit}>
          <label htmlFor="login-identifier"><span>{copy.identifier}</span><input id="login-identifier" type="text" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username webauthn" inputMode="text" placeholder={copy.identifierPlaceholder} autoFocus /></label>
          {method === "password" ? (
            <div className="login-password-field">
              <label htmlFor="login-password"><span>{copy.password}</span></label>
              <span className="login-password-control">
                <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password webauthn" placeholder={copy.passwordPlaceholder} />
                {capabilities.passkey ? (
                  <button className="login-passkey-button" type="button" onClick={() => void startPasskeyLogin()} disabled={submitting} aria-label={copy.passkeyLogin} title={copy.passkeyLogin}>
                    <KeyRound size={17} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
          {method === "email-otp" && otpSent ? (
            <label htmlFor="login-otp"><span>{copy.otp}</span><input id="login-otp" inputMode="numeric" pattern="[0-9]{6}" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder={copy.otpPlaceholder} /></label>
          ) : null}
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          {notice ? <p className="login-notice" role="status">{notice}</p> : null}
          <button className="button button-dark login-submit" type="submit" disabled={submitting}>
            {submitting ? copy.loading : method === "email-otp" ? (otpSent ? copy.verifyAndContinue : copy.sendOtp) : method === "magic-link" ? copy.sendMagicLink : copy.continue}
            {!submitting ? <ArrowRight size={17} aria-hidden="true" /> : null}
          </button>
        </form>

        {socialProviders.length ? (
          <div className="social-login" aria-label={copy.socialMethods}>
            <span className="login-divider">{copy.otherMethods}</span>
            <div className="social-login-buttons">
              {socialProviders.map((provider) => (
                <button key={provider} type="button" disabled={submitting} onClick={() => void startSocialLogin(provider)}>
                  <span className={`social-icon social-icon-${provider}`} aria-hidden="true">{provider === "google" ? "G" : provider === "wechat" ? "微" : provider === "qq" ? "Q" : "支"}</span>
                  {socialLabels[provider][locale]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
      {qrOpen ? (
        <div className="login-qr-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setQrOpen(false); }}>
          <section className="login-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="login-qr-title">
            <button className="login-qr-close" type="button" onClick={() => setQrOpen(false)} aria-label={copy.close}><X size={17} aria-hidden="true" /></button>
            <div className="login-qr-visual" aria-hidden="true"><QrCode size={108} strokeWidth={1.25} /></div>
            <h2 id="login-qr-title">{copy.qrLoginTitle}</h2>
            <p>{copy.qrLoginReserved}</p>
          </section>
        </div>
      ) : null}
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

function normalizePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^1\d{10}$/.test(compact)) return `+86${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

function resolveIdentifier(value: string): { kind: "email" | "phone"; value: string } | null {
  const normalized = value.trim().toLowerCase();
  if (isEmail(normalized)) return { kind: "email", value: normalized };
  const phone = normalizePhone(value);
  return phone ? { kind: "phone", value: phone } : null;
}

function displayNameFromIdentifier(value: string): string {
  const localPart = value.includes("@") ? value.slice(0, value.indexOf("@")) : value;
  return localPart.trim().slice(0, 80) || "MatchPlane 用户";
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

function authCallbackURL(next: string, adminInviteToken: string | null): string {
  if (!adminInviteToken) return next;
  // Better Auth may redirect directly to the callback after a magic-link or social
  // flow. Keep the invite on the shared login route so the token can be redeemed
  // after the callback instead of being stranded on the marketplace home page.
  const params = new URLSearchParams({ admin_invite: adminInviteToken, next });
  return `/login?${params.toString()}`;
}

function authErrorCallbackURL(role: BetterAuthMarketplaceRole, next: string, adminInviteToken: string | null): string {
  const params = new URLSearchParams({ role, next });
  if (adminInviteToken) params.set("admin_invite", adminInviteToken);
  return `/login?${params.toString()}`;
}

function loginCopy(locale: "zh" | "en") {
  if (locale === "en") {
    return {
      back: "Back",
      account: "MatchPlane",
      authMethods: "Authentication methods",
      nationalIdentity: "National online identity",
      socialMethods: "Social sign-in",
      password: "Password",
      emailOtp: "Code",
      magicLink: "Magic link",
      identifier: "Email or phone",
      identifierPlaceholder: "name@example.com or +86 138…",
      passwordPlaceholder: "At least 8 characters",
      otp: "Code",
      otpPlaceholder: "6-digit code",
      loading: "Signing in…",
      verifyAndContinue: "Verify and continue",
      sendOtp: "Send code",
      sendMagicLink: "Send magic link",
      continue: "Continue",
      otherMethods: "Other ways",
      passwordTooShort: "Password must be at least 8 characters.",
      invalidOtp: "Enter the 6-digit code.",
      oauthMagicLinkBlocked: "Use a password or email code for platform authorization.",
      otpSent: "Code sent.",
      magicLinkSent: "Magic link sent.",
      signUpSent: "Check your email to verify your account.",
      authFailed: "Sign-in did not complete. Try again.",
      invalidIdentifier: "Enter a valid email address or phone number.",
      phonePasswordUnavailable: "Use the code method to sign in with a phone number.",
      emailOtpUnavailable: "Email codes are not configured on this platform.",
      phoneOtpUnavailable: "Phone codes are not configured on this platform.",
      phoneMagicLinkUnavailable: "Magic links are sent to email addresses. Use a code for phone sign-in.",
      magicLinkUnavailable: "Magic links are not configured on this platform.",
      phoneOtpSent: "Code sent to your phone.",
      passkeyLogin: "Use a passkey",
      passkeyUnsupported: "This browser or device does not support passkeys.",
      passkeyFailed: "Passkey sign-in did not complete.",
      qrLogin: "Scan",
      qrLoginTitle: "Scan to sign in",
      qrLoginReserved: "Mobile scan sign-in is reserved here and will appear after the QR authorization service is configured.",
      close: "Close",
      socialFailedSuffix: " sign-in failed",
      socialRedirectMissing: "The sign-in provider did not return a redirect.",
      socialFailed: "Social sign-in is unavailable.",
    };
  }
  return {
    back: "返回",
    account: "MatchPlane",
    authMethods: "登录方式",
    nationalIdentity: "国家网络身份认证",
    socialMethods: "第三方登录",
    password: "密码",
    emailOtp: "验证码",
    magicLink: "免密链接",
    identifier: "邮箱或手机号",
    identifierPlaceholder: "name@example.com 或 138…",
    passwordPlaceholder: "至少 8 位",
    otp: "验证码",
    otpPlaceholder: "6 位验证码",
    loading: "正在登录…",
    verifyAndContinue: "验证并继续",
    sendOtp: "发送验证码",
    sendMagicLink: "发送免密链接",
    continue: "继续",
    otherMethods: "其他方式",
    passwordTooShort: "密码至少需要 8 位。",
    invalidOtp: "请输入 6 位验证码。",
    oauthMagicLinkBlocked: "平台授权请使用密码或邮箱验证码。",
    otpSent: "验证码已发送。",
    magicLinkSent: "免密链接已发送。",
    signUpSent: "请查收邮件并完成验证。",
    authFailed: "登录没有完成，请再试一次。",
    invalidIdentifier: "请输入有效的邮箱或手机号。",
    phonePasswordUnavailable: "手机号请使用验证码登录。",
    emailOtpUnavailable: "当前平台尚未配置邮箱验证码服务。",
    phoneOtpUnavailable: "当前平台尚未配置手机验证码服务。",
    phoneMagicLinkUnavailable: "免密链接发送到邮箱，手机号请使用验证码。",
    magicLinkUnavailable: "当前平台尚未配置免密链接服务。",
    phoneOtpSent: "验证码已发送到手机。",
    passkeyLogin: "使用 Passkey",
    passkeyUnsupported: "当前浏览器或设备暂不支持 Passkey。",
    passkeyFailed: "Passkey 登录没有完成。",
    qrLogin: "扫码",
    qrLoginTitle: "扫码登录",
    qrLoginReserved: "手机扫码登录入口已预留，配置二维码授权服务后即可使用。",
    close: "关闭",
    socialFailedSuffix: "登录失败",
    socialRedirectMissing: "登录服务没有返回跳转地址。",
    socialFailed: "第三方登录暂时不可用。",
  };
}
