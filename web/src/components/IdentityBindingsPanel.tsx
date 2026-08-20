"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AtSign, Link2, LoaderCircle, MessageCircleMore, Smartphone } from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { authClient, authFetchOptions } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";

type ProviderId = "google" | "wechat" | "qq" | "alipay";

interface IdentityBindingsPanelProps {
  locale: InterfaceLocale;
  subplatform: SubplatformConfig;
  onNotice: (message: string) => void;
}

interface IdentitySnapshot {
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  linkedProviders: Set<string>;
  providers: ProviderId[];
  phoneOtp: boolean;
}

/** A single Better Auth user may link verified login methods without another credential store. */
export function IdentityBindingsPanel({ locale, subplatform, onNotice }: IdentityBindingsPanelProps) {
  const [identity, setIdentity] = useState<IdentitySnapshot>({
    email: null,
    emailVerified: false,
    phoneNumber: null,
    phoneNumberVerified: false,
    linkedProviders: new Set(),
    providers: [],
    phoneOtp: false,
  });
  const [loading, setLoading] = useState(true);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const [linkingProvider, setLinkingProvider] = useState<ProviderId | null>(null);
  const copy = identityCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const options = authFetchOptions(subplatform.slug);
      const [sessionResult, accountResponse, providersResponse] = await Promise.all([
        authClient.getSession({ fetchOptions: options }),
        fetch("/api/auth/list-accounts", { credentials: "include", headers: { accept: "application/json", ...options.headers } }),
        fetch("/api/auth/providers", { credentials: "include", headers: { accept: "application/json" } }),
      ]);
      const sessionUser = sessionResult.data?.user as {
        email?: unknown;
        emailVerified?: unknown;
        phoneNumber?: unknown;
        phoneNumberVerified?: unknown;
      } | undefined;
      const accounts = accountResponse.ok ? await accountResponse.json() as unknown : [];
      const providers = providersResponse.ok ? await providersResponse.json() as { social?: unknown; phoneOtp?: unknown } : null;
      setIdentity({
        email: typeof sessionUser?.email === "string" ? sessionUser.email : null,
        emailVerified: sessionUser?.emailVerified === true,
        phoneNumber: typeof sessionUser?.phoneNumber === "string" ? sessionUser.phoneNumber : null,
        phoneNumberVerified: sessionUser?.phoneNumberVerified === true,
        linkedProviders: new Set(Array.isArray(accounts) ? accounts.flatMap((account): string[] => {
          if (!account || typeof account !== "object") return [];
          const providerId = (account as { providerId?: unknown }).providerId;
          return typeof providerId === "string" ? [providerId] : [];
        }) : []),
        providers: Array.isArray(providers?.social)
          ? providers.social.filter((provider): provider is ProviderId => provider === "google" || provider === "wechat" || provider === "qq" || provider === "alipay")
          : [],
        phoneOtp: providers?.phoneOtp === true,
      });
    } catch {
      onNotice(copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, onNotice, subplatform.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendPhoneCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      onNotice(copy.invalidPhone);
      return;
    }
    setSavingPhone(true);
    try {
      const result = await authClient.phoneNumber.sendOtp({ phoneNumber: normalizedPhone, fetchOptions: authFetchOptions(subplatform.slug) });
      if (result.error) throw new Error(result.error.message || copy.phoneFailed);
      setPhone(normalizedPhone);
      setPhoneCode("");
      setPhoneCodeSent(true);
      onNotice(copy.phoneCodeSent);
    } catch (error) {
      onNotice(error instanceof Error && error.message ? copy.phoneFailed : copy.phoneFailed);
    } finally {
      setSavingPhone(false);
    }
  };

  const confirmPhone = async () => {
    if (!/^\d{6}$/.test(phoneCode)) {
      onNotice(copy.invalidCode);
      return;
    }
    setSavingPhone(true);
    try {
      const result = await authClient.phoneNumber.verify({
        phoneNumber: phone,
        code: phoneCode,
        updatePhoneNumber: true,
        disableSession: true,
        fetchOptions: authFetchOptions(subplatform.slug),
      } as never);
      if (result.error) throw new Error(result.error.message || copy.phoneFailed);
      setPhoneOpen(false);
      setPhoneCodeSent(false);
      setPhoneCode("");
      await load();
      onNotice(copy.phoneBound);
    } catch {
      onNotice(copy.phoneFailed);
    } finally {
      setSavingPhone(false);
    }
  };

  const linkProvider = async (provider: ProviderId) => {
    if (linkingProvider) return;
    setLinkingProvider(provider);
    try {
      const callback = new URL(window.location.href);
      callback.searchParams.set("account", "identity");
      const response = await fetch("/api/auth/link-social", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json", ...authFetchOptions(subplatform.slug).headers },
        body: JSON.stringify({
          provider,
          callbackURL: `${callback.pathname}${callback.search}`,
          errorCallbackURL: `${callback.pathname}${callback.search}`,
          disableRedirect: true,
        }),
      });
      const body = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string" || !body.url) throw new Error(copy.providerFailed);
      window.location.assign(body.url);
    } catch {
      setLinkingProvider(null);
      onNotice(copy.providerFailed);
    }
  };

  return (
    <section className="workspace-settings-section identity-bindings-panel" aria-labelledby="identity-bindings-title">
      <div className="workspace-settings-section-heading">
        <div>
          <h3 id="identity-bindings-title">{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <Link2 size={20} aria-hidden="true" />
      </div>
      <ul className="identity-binding-list" aria-label={copy.title}>
        <li><AtSign size={18} aria-hidden="true" /><span><strong>{copy.email}</strong><small>{identity.email ?? copy.unavailable}</small></span><em>{identity.emailVerified ? copy.bound : copy.unverified}</em></li>
        <li><Smartphone size={18} aria-hidden="true" /><span><strong>{copy.phone}</strong><small>{identity.phoneNumber ?? copy.notBound}</small></span>{identity.phoneNumberVerified ? <em>{copy.bound}</em> : identity.phoneOtp ? <Button variant="outline" type="button" onClick={() => setPhoneOpen((open) => !open)} disabled={loading}>{copy.bindPhone}</Button> : <em>{copy.notConfigured}</em>}</li>
        {identity.providers.map((provider) => (
          <li key={provider}><ProviderIcon provider={provider} /><span><strong>{providerLabel(provider, locale)}</strong><small>{identity.linkedProviders.has(provider) ? copy.boundLogin : copy.notBound}</small></span>{identity.linkedProviders.has(provider) ? <em>{copy.bound}</em> : <Button variant="outline" type="button" disabled={Boolean(linkingProvider) || loading} onClick={() => void linkProvider(provider)}>{linkingProvider === provider ? <LoaderCircle className="identity-binding-spinner" size={16} aria-hidden="true" /> : null}{copy.bindProvider}</Button>}</li>
        ))}
      </ul>
      {phoneOpen ? (
        <form className="identity-phone-form" onSubmit={phoneCodeSent ? (event) => { event.preventDefault(); void confirmPhone(); } : sendPhoneCode}>
          <label><span>{copy.phone}</span><input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="+86 138 0000 0000" readOnly={phoneCodeSent} /></label>
          {phoneCodeSent ? <label><span>{copy.code}</span><input value={phoneCode} onChange={(event) => setPhoneCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder={copy.codePlaceholder} /></label> : null}
          <Button type="submit" variant="outline" disabled={savingPhone}>{savingPhone ? copy.saving : phoneCodeSent ? copy.confirmPhone : copy.sendPhoneCode}</Button>
        </form>
      ) : null}
    </section>
  );
}

function normalizePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^1\d{10}$/.test(compact)) return `+86${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

function ProviderIcon({ provider }: { provider: ProviderId }) {
  return provider === "wechat" ? <MessageCircleMore size={18} aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />;
}

function providerLabel(provider: ProviderId, locale: InterfaceLocale): string {
  const labels: Record<ProviderId, [string, string]> = {
    wechat: ["微信", "WeChat"],
    google: ["Google", "Google"],
    qq: ["QQ", "QQ"],
    alipay: ["支付宝", "Alipay"],
  };
  return labels[provider][locale === "zh" ? 0 : 1];
}

function identityCopy(locale: InterfaceLocale) {
  return locale === "zh" ? {
    title: "登录方式",
    description: "已验证的登录方式会作为账号身份绑定；联系方式仍只在双方同意后交换。",
    email: "邮箱",
    phone: "手机号",
    bound: "已绑定",
    boundLogin: "已绑定登录",
    unverified: "未验证",
    notBound: "未绑定",
    unavailable: "暂不可用",
    notConfigured: "未启用",
    bindPhone: "绑定手机号",
    bindProvider: "绑定",
    sendPhoneCode: "发送验证码",
    confirmPhone: "确认绑定",
    code: "验证码",
    codePlaceholder: "6 位验证码",
    saving: "处理中…",
    phoneCodeSent: "验证码已发送到该手机号。",
    phoneBound: "手机号已验证并绑定。",
    invalidPhone: "请输入有效的手机号。",
    invalidCode: "请输入 6 位验证码。",
    phoneFailed: "手机号绑定没有完成，请重试。",
    providerFailed: "账号绑定没有完成，请重试。",
    loadFailed: "登录方式暂时无法读取。",
  } : {
    title: "Sign-in methods",
    description: "Verified sign-in methods are bound to your account; contacts are still exchanged only after both sides agree.",
    email: "Email",
    phone: "Phone",
    bound: "Bound",
    boundLogin: "Bound for sign-in",
    unverified: "Unverified",
    notBound: "Not bound",
    unavailable: "Unavailable",
    notConfigured: "Not enabled",
    bindPhone: "Bind phone",
    bindProvider: "Bind",
    sendPhoneCode: "Send code",
    confirmPhone: "Confirm binding",
    code: "Code",
    codePlaceholder: "6-digit code",
    saving: "Working…",
    phoneCodeSent: "A code was sent to this phone number.",
    phoneBound: "Phone number verified and bound.",
    invalidPhone: "Enter a valid phone number.",
    invalidCode: "Enter the 6-digit code.",
    phoneFailed: "Phone binding did not complete. Try again.",
    providerFailed: "Account binding did not complete. Try again.",
    loadFailed: "Sign-in methods are temporarily unavailable.",
  };
}
