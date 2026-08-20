"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, EyeOff, Fingerprint } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { Input } from "@appica/ui-react/input";

import {
  establishMarketplaceSession,
  isLiveMarketplaceEnabled,
  redeemPlatformAdminInvite,
  type BetterAuthMarketplaceRole,
} from "../api";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { useInterfacePreferences } from "../lib/preferences";
import { loadSubplatform, resolveSubplatform, type SubplatformConfig } from "../subplatform";
import { Brand } from "./Primitives";
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

export function LoginScreen({ intent = "sign-in" }: { intent?: "sign-in" | "sign-up" }) {
  const { theme, locale, setTheme, setLocale } = useInterfacePreferences();
  const copy = loginCopy(locale);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState("");
  const [method, setMethod] = useState<AuthMethod>("password");
  const [authIntent, setAuthIntent] = useState<"sign-in" | "sign-up">(intent);
  const [next, setNext] = useState("/");
  const [oauthQuery, setOauthQuery] = useState<string | null>(null);
  const [adminInviteToken, setAdminInviteToken] = useState<string | null>(null);
  const [superAdminBootstrapToken, setSuperAdminBootstrapToken] = useState<string | null>(null);
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
  const [registrationPending, setRegistrationPending] = useState(false);
  const [passwordResetMode, setPasswordResetMode] = useState(false);
  const [passwordResetOtpSent, setPasswordResetOtpSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const redeemingInviteRef = useRef(false);
  const authMethodsId = useId();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signedOAuthQuery = params.has("sig") && params.has("client_id") && params.has("redirect_uri")
      ? params.toString()
      : null;
    setOauthQuery(signedOAuthQuery);
    const bootstrap = params.get("bootstrap_token");
    const bootstrapToken = bootstrap && /^mpsa_[0-9a-f]{64}$/.test(bootstrap) ? bootstrap : null;
    setSuperAdminBootstrapToken(bootstrapToken);
    const invite = params.get("token") || params.get("admin_invite");
    const inviteToken = invite && /^mpa_[0-9a-f]{64}$/.test(invite) ? invite : null;
    setAdminInviteToken(inviteToken);
    if (inviteToken || bootstrapToken) {
      setAuthIntent("sign-up");
    }
    const requestedRole = params.get("role");
    setRole(
      bootstrapToken || inviteToken
        ? "platform"
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
    if (authIntent === "sign-up" && method === "password" && resolvedIdentifier.kind !== "email") {
      setError(copy.registrationEmailOnly);
      return;
    }
    if (passwordResetMode && resolvedIdentifier.kind !== "email") {
      setError(copy.registrationEmailOnly);
      return;
    }
    if (method === "password" && resolvedIdentifier.kind === "phone") {
      setError(isRegistration ? copy.registrationEmailOnly : copy.invalidCredentials);
      return;
    }
    if (registrationPending) {
      if (resolvedIdentifier.kind !== "email") {
        setError(copy.invalidIdentifier);
        return;
      }
      if (!/^\d{6}$/.test(otp.trim())) {
        setError(copy.invalidOtp);
        return;
      }
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
    if (method === "password" && !registrationPending && !passwordResetMode && password.length < 8) {
      setError(copy.passwordTooShort);
      return;
    }
    if (authIntent === "sign-up" && method === "password" && !registrationPending && password !== confirmPassword) {
      setError(copy.passwordMismatch);
      return;
    }
    if (method === "email-otp" && otpSent && !/^\d{6}$/.test(otp.trim())) {
      setError(copy.invalidOtp);
      return;
    }
    if (passwordResetMode && passwordResetOtpSent) {
      if (!/^\d{6}$/.test(otp.trim())) {
        setError(copy.invalidOtp);
        return;
      }
      if (password.length < 8) {
        setError(copy.passwordTooShort);
        return;
      }
      if (password !== confirmPassword) {
        setError(copy.passwordMismatch);
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const options = authFetchOptions(subplatform.slug);
      if (passwordResetMode) {
        if (!passwordResetOtpSent) {
          const response = await fetch("/api/auth/email-otp/request-password-reset", {
            method: "POST",
            credentials: "include",
            headers: { accept: "application/json", "content-type": "application/json", ...options.headers },
            body: JSON.stringify({ email: resolvedIdentifier.value }),
          });
          if (!response.ok) throw new Error(copy.passwordResetFailed);
          setPasswordResetOtpSent(true);
          setOtp("");
          setNotice(copy.passwordResetOtpSent);
          setSubmitting(false);
          return;
        }
        const response = await fetch("/api/auth/email-otp/reset-password", {
          method: "POST",
          credentials: "include",
          headers: { accept: "application/json", "content-type": "application/json", ...options.headers },
          body: JSON.stringify({ email: resolvedIdentifier.value, otp: otp.trim(), password }),
        });
        if (!response.ok) throw new Error(copy.passwordResetFailed);
        setPasswordResetMode(false);
        setPasswordResetOtpSent(false);
        setPassword("");
        setConfirmPassword("");
        setOtp("");
        setNotice(copy.passwordResetComplete);
        setSubmitting(false);
        return;
      }
      if (registrationPending) {
        const result = await authClient.emailOtp.verifyEmail({
          email: resolvedIdentifier.value,
          otp: otp.trim(),
          fetchOptions: options,
        } as never);
        if (result.error) throw new Error(result.error.message || copy.authFailed);
        setRegistrationPending(false);
        await finishSignIn();
        return;
      }
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

      if (authIntent === "sign-up") {
        if (resolvedIdentifier.kind !== "email") throw new Error(copy.registrationEmailOnly);
        if (superAdminBootstrapToken) {
          const claim = await fetch("/api/super-admin-bootstrap/claim", {
            method: "POST",
            credentials: "include",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ token: superAdminBootstrapToken, email: resolvedIdentifier.value }),
          });
          const claimBody = await claim.json().catch(() => null) as { error?: string } | null;
          if (!claim.ok) throw new Error(claimBody?.error || copy.authFailed);
        }
        if (!superAdminBootstrapToken) {
          const registrationState = await readRegistrationIdentity(resolvedIdentifier.value);
          if (registrationState === "pending_verification") {
            if (!capabilities.emailOtp) throw new Error(copy.emailOtpUnavailable);
            const resent = await authClient.emailOtp.sendVerificationOtp({
              email: resolvedIdentifier.value,
              type: "email-verification",
              fetchOptions: options,
            } as never);
            if (resent.error) throw new Error(resent.error.message || copy.emailOtpUnavailable);
            setRegistrationPending(true);
            setOtp("");
            setNotice(copy.registrationOtpResent);
            setSubmitting(false);
            return;
          }
          if (registrationState === "existing") {
            // One Better Auth account can participate in more than one platform
            // and on either marketplace side.  Prove ownership of that account,
            // then let finishSignIn create or reuse only the requested scoped
            // marketplace capability.  This keeps the operation idempotent for
            // an already registered side on the current platform.
            const signedIn = await authClient.signIn.email({
              email: resolvedIdentifier.value,
              password,
              callbackURL: authCallbackURL(next, adminInviteToken),
              fetchOptions: options,
            } as never);
            if (signedIn.error) {
              setError(copy.existingAccountPasswordFailed);
              setSubmitting(false);
              return;
            }
            await finishSignIn();
            return;
          }
          if (!capabilities.emailOtp && !capabilities.magicLink) throw new Error(copy.emailOtpUnavailable);
        }
        const created = await authClient.signUp.email({
          name: displayNameFromIdentifier(resolvedIdentifier.value),
          email: resolvedIdentifier.value,
          password,
          callbackURL: authCallbackURL(next, adminInviteToken),
          fetchOptions: options,
        } as never);
        if (!created.error) {
          if (superAdminBootstrapToken) {
            const signedIn = await authClient.signIn.email({
              email: resolvedIdentifier.value,
              password,
              callbackURL: authCallbackURL(next, adminInviteToken),
              fetchOptions: options,
            } as never);
            if (signedIn.error) throw new Error(copy.authFailed);
            await finishSignIn();
            return;
          }
          const sent = await authClient.emailOtp.sendVerificationOtp({
            email: resolvedIdentifier.value,
            type: "email-verification",
            fetchOptions: options,
          } as never);
          if (sent.error) throw new Error(sent.error.message || copy.emailOtpUnavailable);
          setRegistrationPending(true);
          setOtp("");
          setNotice(copy.registrationOtpSent);
          setSubmitting(false);
          return;
        }
        throw new Error(created.error.message || copy.authFailed);
      }
      const result = await authClient.signIn.email({
        email: resolvedIdentifier.value,
        password,
        callbackURL: authCallbackURL(next, adminInviteToken),
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        fetchOptions: options,
      } as never);
      if (result.error) throw new Error(copy.invalidCredentials);
      const oauthRedirect = oauthRedirectUrl(result.data);
      if (oauthQuery && oauthRedirect) {
        window.location.assign(oauthRedirect);
        return;
      }
      await finishSignIn();
    } catch (cause) {
      setError(passwordResetMode
        ? copy.passwordResetFailed
        : !isRegistration && method === "password" ? copy.invalidCredentials : copy.authFailed);
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

  const switchMethod = (nextMethod: AuthMethod) => {
    setMethod(nextMethod);
    setOtpSent(false);
    setRegistrationPending(false);
    setPasswordResetMode(false);
    setPasswordResetOtpSent(false);
    setShowPassword(false);
    setConfirmPassword("");
    setOtp("");
    setError(null);
    setNotice(null);
  };

  const availableMethods: AuthMethod[] = ["password"];
  const isRegistration = authIntent === "sign-up";
  const emailOnlyIdentifier = isRegistration || registrationPending || passwordResetMode;
  const hasMethodTabs = availableMethods.length > 1;
  const activeMethodTabId = `${authMethodsId}-${method}-tab`;
  const registrationHref = `/register?next=${encodeURIComponent(next)}`;
  const loginHref = `/login?next=${encodeURIComponent(next)}`;

  return (
    <main className="login-page">
      <div className="login-topbar">
        <a className="login-back" href="/" aria-label={copy.back}>
          <ArrowLeft size={18} aria-hidden="true" /><span>{copy.back}</span>
        </a>
        <PreferenceControls theme={theme} locale={locale} onThemeChange={setTheme} onLocaleChange={setLocale} />
      </div>
      <div className="login-layout">
        <section className="login-card" aria-labelledby="login-form-title">
          <div className="login-card-header">
            <Brand label={subplatform.brandName} homeHref="/" />
            <h1 id="login-form-title">{passwordResetMode ? copy.passwordResetTitle : isRegistration ? copy.registrationTitle : copy.formTitle}</h1>
            <p>{passwordResetMode ? copy.passwordResetDescription : isRegistration ? copy.registrationDescription : copy.formDescription}</p>
          </div>

        {nationalIdentityEnabled ? (
          <div className="login-primary-provider">
            <Button type="button" disabled={submitting} onClick={() => void startSocialLogin("national_identity")}>
              <Fingerprint size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.nationalIdentity}</span>
            </Button>
          </div>
        ) : null}

        {hasMethodTabs ? (
          <div className={`login-methods login-methods-count-${availableMethods.length}`} role="tablist" aria-label={copy.authMethods}>
            <button id={`${authMethodsId}-password-tab`} className={method === "password" ? "is-active" : ""} type="button" role="tab" aria-controls={`${authMethodsId}-panel`} aria-selected={method === "password"} onClick={() => switchMethod("password")}>{copy.password}</button>
            {availableMethods.includes("email-otp") ? <button id={`${authMethodsId}-email-otp-tab`} className={method === "email-otp" ? "is-active" : ""} type="button" role="tab" aria-controls={`${authMethodsId}-panel`} aria-selected={method === "email-otp"} onClick={() => switchMethod("email-otp")}>{copy.emailOtp}</button> : null}
            {availableMethods.includes("magic-link") ? <button id={`${authMethodsId}-magic-link-tab`} className={method === "magic-link" ? "is-active" : ""} type="button" role="tab" aria-controls={`${authMethodsId}-panel`} aria-selected={method === "magic-link"} onClick={() => switchMethod("magic-link")}>{copy.magicLink}</button> : null}
          </div>
        ) : null}

        {!adminInviteToken && !oauthQuery && role === "platform" ? <p className="login-admin-invite-note">{copy.adminInviteRequired}</p> : null}

        <form id={hasMethodTabs ? `${authMethodsId}-panel` : undefined} className="login-form" role={hasMethodTabs ? "tabpanel" : undefined} aria-labelledby={hasMethodTabs ? activeMethodTabId : undefined} onSubmit={submit}>
          <label htmlFor="login-identifier">
            <span>{emailOnlyIdentifier ? copy.email : copy.identifier}</span>
            <Input id="login-identifier" type="text" value={identifier} onChange={(event) => setIdentifier(event.target.value)} readOnly={registrationPending || (passwordResetMode && passwordResetOtpSent)} autoComplete="username webauthn" inputMode="text" placeholder={emailOnlyIdentifier ? copy.emailPlaceholder : copy.identifierPlaceholder} autoFocus />
          </label>
          {method === "password" && !registrationPending && (!passwordResetMode || passwordResetOtpSent) ? (
            <div className="login-password-field">
              <label htmlFor="login-password"><span>{copy.password}</span></label>
              <span className="login-password-control">
                <Input id="login-password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authIntent === "sign-up" || passwordResetMode ? "new-password" : "current-password webauthn"} placeholder={copy.passwordPlaceholder} />
                <span className="login-password-actions">
                  <Button className="login-password-visibility" variant="outline" size="icon-sm" type="button" onClick={() => setShowPassword((visible) => !visible)} disabled={submitting} aria-label={showPassword ? copy.hidePassword : copy.showPassword} title={showPassword ? copy.hidePassword : copy.showPassword}>
                    {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                  </Button>
                </span>
              </span>
            </div>
          ) : null}
          {method === "password" && (isRegistration || passwordResetMode) && !registrationPending && (!passwordResetMode || passwordResetOtpSent) ? (
            <div className="login-password-field">
              <label htmlFor="login-password-confirm"><span>{copy.confirmPassword}</span></label>
              <span className="login-password-control">
                <Input id="login-password-confirm" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder={copy.confirmPasswordPlaceholder} />
              </span>
            </div>
          ) : null}
          {((method === "email-otp" && otpSent) || registrationPending || passwordResetOtpSent) ? (
            <label htmlFor="login-otp"><span>{copy.otp}</span><Input id="login-otp" inputMode="numeric" pattern="[0-9]{6}" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder={copy.otpPlaceholder} /></label>
          ) : null}
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          {notice ? <p className="login-notice" role="status">{notice}</p> : null}
          <Button className="login-submit" type="submit" disabled={submitting}>
            {submitting ? copy.loading : passwordResetMode ? (passwordResetOtpSent ? copy.resetPassword : copy.sendPasswordResetOtp) : registrationPending ? copy.verifyAndCreate : method === "email-otp" ? (otpSent ? copy.verifyAndContinue : copy.sendOtp) : method === "magic-link" ? copy.sendMagicLink : authIntent === "sign-up" ? copy.sendRegistrationOtp : copy.continue}
            {!submitting ? <ArrowRight size={17} aria-hidden="true" /> : null}
          </Button>
        </form>

        {socialProviders.length && !isRegistration ? (
          <div className="social-login" aria-label={copy.socialMethods}>
            <span className="login-divider">{copy.otherMethods}</span>
            <div className="social-login-buttons">
              {socialProviders.map((provider) => (
                <Button key={provider} variant="outline" type="button" disabled={submitting} onClick={() => void startSocialLogin(provider)}>
                  <span className={`social-icon social-icon-${provider}`} aria-hidden="true">{provider === "google" ? "G" : provider === "wechat" ? "微" : provider === "qq" ? "Q" : "支"}</span>
                  {socialLabels[provider][locale]}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {!adminInviteToken && !oauthQuery && role !== "platform" && !registrationPending ? (
          <p className="login-registration-link">
            {passwordResetMode ? <button className="login-link-button" type="button" onClick={() => { setPasswordResetMode(false); setPasswordResetOtpSent(false); setPassword(""); setConfirmPassword(""); setOtp(""); setError(null); setNotice(null); }}>{copy.backToSignIn}</button> : isRegistration ? <>{copy.hasAccount} <a href={loginHref}>{copy.signIn}</a></> : <>{copy.noAccount} <a href={registrationHref}>{copy.signUp}</a> <button className="login-link-button" type="button" onClick={() => { setPasswordResetMode(true); setPassword(""); setConfirmPassword(""); setOtp(""); setError(null); setNotice(null); }}>{copy.forgotPassword}</button></>}
          </p>
        ) : null}
        </section>
      </div>
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

type RegistrationIdentityState = "new" | "existing" | "pending_verification";

async function readRegistrationIdentity(email: string): Promise<RegistrationIdentityState> {
  const response = await fetch("/api/registration/identity", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await response.json().catch(() => null) as { state?: unknown; error?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "注册状态暂时不可用");
  const state = body?.state;
  if (state === "new" || state === "existing" || state === "pending_verification") return state;
  throw new Error("注册状态暂时不可用");
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const resolved = new URL(value, window.location.origin);
    // Better Auth validates callback URLs as origins/paths and rejects fragments. The hash is
    // browser-local state, so dropping it keeps login valid when a user arrives from a page
    // anchor such as `/?role=buyer#top`.
    return resolved.origin === window.location.origin ? `${resolved.pathname}${resolved.search}` : "/";
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
      formTitle: "Continue with your account",
      formDescription: "Use email or another method enabled for this platform.",
      registrationTitle: "Create your account",
      registrationDescription: "One account lets you find what you need and publish your own listings.",
      passwordResetTitle: "Reset your password",
      passwordResetDescription: "We will send a six-digit code to your email, then you can set a new password.",
      signIn: "Sign in",
      signUp: "Register",
      noAccount: "No account?",
      hasAccount: "Already have an account?",
      forgotPassword: "Forgot password?",
      backToSignIn: "Back to sign in",
      admin: "Administrator",
      adminDetail: "Invited platform management only",
      adminInviteRequired: "Administrator registration is available only from a verified invitation link.",
      authMethods: "Authentication methods",
      nationalIdentity: "National online identity",
      socialMethods: "Social sign-in",
      password: "Password",
      confirmPassword: "Confirm password",
      emailOtp: "Code",
      magicLink: "Magic link",
      email: "Email",
      emailPlaceholder: "name@example.com",
      identifier: "Email or phone",
      identifierPlaceholder: "name@example.com or +86 138…",
      passwordPlaceholder: "At least 8 characters",
      confirmPasswordPlaceholder: "Enter the password again",
      otp: "Code",
      otpPlaceholder: "6-digit code",
      loading: "Signing in…",
      verifyAndContinue: "Verify and continue",
      verifyAndCreate: "Verify and create account",
      sendRegistrationOtp: "Send verification code",
      sendPasswordResetOtp: "Send reset code",
      resetPassword: "Save new password",
      sendOtp: "Send code",
      sendMagicLink: "Send magic link",
      continue: "Continue",
      otherMethods: "Other ways",
      passwordTooShort: "Password must be at least 8 characters.",
      passwordMismatch: "The two passwords do not match.",
      existingAccountPasswordFailed: "This email already has an account. Enter its existing password, or use the sign-in page.",
      invalidOtp: "Enter the 6-digit code.",
      oauthMagicLinkBlocked: "Use a password or email code for platform authorization.",
      otpSent: "Code sent.",
      registrationOtpSent: "A verification code was sent to your email.",
      registrationOtpResent: "This email has a pending registration. A new verification code was sent.",
      passwordResetOtpSent: "If this email has an account, a reset code was sent.",
      passwordResetComplete: "Password updated. You can sign in with the new password.",
      passwordResetFailed: "Password reset did not complete. Check the code and try again.",
      magicLinkSent: "Magic link sent.",
      authFailed: "Sign-in did not complete. Try again.",
      invalidIdentifier: "Enter a valid email address or phone number.",
      invalidCredentials: "Account does not exist or password is incorrect.",
      registrationEmailOnly: "Register with an email address. Phone registration appears after SMS is configured.",
      phonePasswordUnavailable: "Use the code method to sign in with a phone number.",
      emailOtpUnavailable: "Email codes are not configured on this platform.",
      phoneOtpUnavailable: "Phone codes are not configured on this platform.",
      phoneMagicLinkUnavailable: "Magic links are sent to email addresses. Use a code for phone sign-in.",
      magicLinkUnavailable: "Magic links are not configured on this platform.",
      phoneOtpSent: "Code sent to your phone.",
      passkeyLogin: "Use a passkey",
      showPassword: "Show password",
      hidePassword: "Hide password",
      passkeyUnsupported: "This browser or device does not support passkeys.",
      passkeyFailed: "Passkey sign-in did not complete.",
      socialFailedSuffix: " sign-in failed",
      socialRedirectMissing: "The sign-in provider did not return a redirect.",
      socialFailed: "Social sign-in is unavailable.",
    };
  }
  return {
    back: "返回",
    formTitle: "继续使用你的账号",
    formDescription: "使用邮箱，或选择当前平台已启用的其他方式。",
    registrationTitle: "创建你的账号",
    registrationDescription: "一个账号既能寻找需要的商品，也能发布自己的商品。",
    passwordResetTitle: "重置密码",
    passwordResetDescription: "我们会向你的邮箱发送 6 位验证码，然后设置新密码。",
    signIn: "登录",
    signUp: "注册",
    noAccount: "没有账号？",
    hasAccount: "已有账号？",
    forgotPassword: "忘记密码？",
    backToSignIn: "返回登录",
    admin: "管理员",
    adminDetail: "仅限受邀的平台管理",
    adminInviteRequired: "管理员注册仅能通过超级管理员发出的邀请链接进行。",
    authMethods: "登录方式",
    nationalIdentity: "国家网络身份认证",
    socialMethods: "第三方登录",
    password: "密码",
    confirmPassword: "确认密码",
    emailOtp: "验证码",
    magicLink: "免密链接",
    email: "邮箱",
    emailPlaceholder: "name@example.com",
    identifier: "邮箱或手机号",
    identifierPlaceholder: "name@example.com 或 138…",
    passwordPlaceholder: "至少 8 位",
    confirmPasswordPlaceholder: "请再次输入密码",
    otp: "验证码",
    otpPlaceholder: "6 位验证码",
    loading: "正在登录…",
    verifyAndContinue: "验证并继续",
    verifyAndCreate: "验证并创建账号",
    sendRegistrationOtp: "发送验证码",
    sendPasswordResetOtp: "发送重置验证码",
    resetPassword: "保存新密码",
    sendOtp: "发送验证码",
    sendMagicLink: "发送免密链接",
    continue: "继续",
    otherMethods: "其他方式",
    passwordTooShort: "密码至少需要 8 位。",
    passwordMismatch: "两次输入的密码不一致。",
    existingAccountPasswordFailed: "该邮箱已有账号，请输入原密码，或前往登录。",
    invalidOtp: "请输入 6 位验证码。",
    oauthMagicLinkBlocked: "平台授权请使用密码或邮箱验证码。",
    otpSent: "验证码已发送。",
    registrationOtpSent: "验证码已发送至你的邮箱。",
    registrationOtpResent: "该邮箱的注册尚待验证，新的验证码已发送。",
    passwordResetOtpSent: "如果该邮箱已注册，重置验证码已发送。",
    passwordResetComplete: "密码已更新，请使用新密码登录。",
    passwordResetFailed: "密码重置没有完成，请检查验证码后重试。",
    magicLinkSent: "免密链接已发送。",
    authFailed: "登录没有完成，请再试一次。",
    invalidIdentifier: "请输入有效的邮箱或手机号。",
    invalidCredentials: "账号不存在或密码错误。",
    registrationEmailOnly: "请使用邮箱注册；配置短信服务后才会显示手机号注册。",
    phonePasswordUnavailable: "手机号请使用验证码登录。",
    emailOtpUnavailable: "当前平台尚未配置邮箱验证码服务。",
    phoneOtpUnavailable: "当前平台尚未配置手机验证码服务。",
    phoneMagicLinkUnavailable: "免密链接发送到邮箱，手机号请使用验证码。",
    magicLinkUnavailable: "当前平台尚未配置免密链接服务。",
    phoneOtpSent: "验证码已发送到手机。",
    passkeyLogin: "使用 Passkey",
    showPassword: "显示密码",
    hidePassword: "隐藏密码",
    passkeyUnsupported: "当前浏览器或设备暂不支持 Passkey。",
    passkeyFailed: "Passkey 登录没有完成。",
    socialFailedSuffix: "登录失败",
    socialRedirectMissing: "登录服务没有返回跳转地址。",
    socialFailed: "第三方登录暂时不可用。",
  };
}
