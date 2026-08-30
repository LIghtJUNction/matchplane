"use client";

import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import {
  AtSign,
  BadgeCheck,
  Link2,
  LoaderCircle,
  MessageCircleMore,
  Smartphone,
  WalletCards,
} from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { authClient, authFetchOptions } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";

type ProviderId = "national_identity" | "google" | "wechat" | "qq" | "alipay";

const CORE_BINDING_PROVIDERS: readonly ProviderId[] = [
  "national_identity",
  "wechat",
  "alipay",
];

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
  configuredProviders: Set<ProviderId>;
  providers: ProviderId[];
  phoneOtp: boolean;
  emailOtp: boolean;
}

/** A single Better Auth user may link verified login methods without another credential store. */
export function IdentityBindingsPanel({
  locale,
  subplatform,
  onNotice,
}: IdentityBindingsPanelProps) {
  const [identity, setIdentity] = useState<IdentitySnapshot>({
    email: null,
    emailVerified: false,
    phoneNumber: null,
    phoneNumberVerified: false,
    linkedProviders: new Set(),
    configuredProviders: new Set(),
    providers: [...CORE_BINDING_PROVIDERS],
    phoneOtp: false,
    emailOtp: false,
  });
  const [loading, setLoading] = useState(true);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [linkingProvider, setLinkingProvider] = useState<ProviderId | null>(
    null,
  );
  const copy = identityCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const options = authFetchOptions(subplatform.slug);
      const [sessionResult, accountResponse, providersResponse] =
        await Promise.all([
          authClient.getSession({ fetchOptions: options }),
          fetch("/api/auth/list-accounts", {
            credentials: "include",
            headers: { accept: "application/json", ...options.headers },
          }),
          fetch("/api/auth/providers", {
            credentials: "include",
            headers: { accept: "application/json" },
          }),
        ]);
      const sessionUser = sessionResult.data?.user as
        | {
            email?: unknown;
            emailVerified?: unknown;
            phoneNumber?: unknown;
            phoneNumberVerified?: unknown;
          }
        | undefined;
      const accounts = accountResponse.ok
        ? ((await accountResponse.json()) as unknown)
        : [];
      const providers = providersResponse.ok
        ? ((await providersResponse.json()) as {
            primary?: unknown;
            social?: unknown;
            phoneOtp?: unknown;
            emailOtp?: unknown;
          })
        : null;
      const linkedProviders = new Set(
        Array.isArray(accounts)
          ? accounts.flatMap((account): string[] => {
              if (!account || typeof account !== "object") return [];
              const providerId = (account as { providerId?: unknown })
                .providerId;
              return typeof providerId === "string" ? [providerId] : [];
            })
          : [],
      );
      const configuredProviders = new Set(
        [
          ...(Array.isArray(providers?.primary) ? providers.primary : []),
          ...(Array.isArray(providers?.social) ? providers.social : []),
        ].filter(isProviderId),
      );
      const visibleProviders = [
        ...new Set([
          ...CORE_BINDING_PROVIDERS,
          ...configuredProviders,
          ...[...linkedProviders].filter(isProviderId),
        ]),
      ];
      setIdentity({
        email:
          typeof sessionUser?.email === "string" ? sessionUser.email : null,
        emailVerified: sessionUser?.emailVerified === true,
        phoneNumber:
          typeof sessionUser?.phoneNumber === "string"
            ? sessionUser.phoneNumber
            : null,
        phoneNumberVerified: sessionUser?.phoneNumberVerified === true,
        linkedProviders,
        configuredProviders,
        providers: visibleProviders,
        phoneOtp: providers?.phoneOtp === true,
        emailOtp: providers?.emailOtp === true,
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

  const sendPhoneCode = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      onNotice(copy.invalidPhone);
      return;
    }
    setSavingPhone(true);
    try {
      const result = await authClient.phoneNumber.sendOtp({
        phoneNumber: normalizedPhone,
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (result.error)
        throw new Error(result.error.message || copy.phoneFailed);
      setPhone(normalizedPhone);
      setPhoneCode("");
      setPhoneCodeSent(true);
      onNotice(copy.phoneCodeSent);
    } catch {
      onNotice(copy.phoneFailed);
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
      if (result.error)
        throw new Error(result.error.message || copy.phoneFailed);
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

  const sendEmailCode = async () => {
    if (!identity.email || savingEmail) return;
    setSavingEmail(true);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: identity.email,
        type: "email-verification",
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (result.error)
        throw new Error(result.error.message || copy.emailFailed);
      setEmailCode("");
      setEmailCodeSent(true);
      onNotice(copy.emailCodeSent);
    } catch {
      onNotice(copy.emailFailed);
    } finally {
      setSavingEmail(false);
    }
  };

  const confirmEmail = async () => {
    if (!identity.email) return;
    if (!/^\d{6}$/.test(emailCode)) {
      onNotice(copy.invalidCode);
      return;
    }
    setSavingEmail(true);
    try {
      const result = await authClient.emailOtp.verifyEmail({
        email: identity.email,
        otp: emailCode,
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (result.error)
        throw new Error(result.error.message || copy.emailFailed);
      setEmailCodeSent(false);
      setEmailCode("");
      await load();
      onNotice(copy.emailVerifiedNotice);
    } catch {
      onNotice(copy.emailFailed);
    } finally {
      setSavingEmail(false);
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
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...authFetchOptions(subplatform.slug).headers,
        },
        body: JSON.stringify({
          provider,
          callbackURL: `${callback.pathname}${callback.search}`,
          errorCallbackURL: `${callback.pathname}${callback.search}`,
          disableRedirect: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok || typeof body?.url !== "string" || !body.url)
        throw new Error(copy.providerFailed);
      window.location.assign(body.url);
    } catch {
      setLinkingProvider(null);
      onNotice(copy.providerFailed);
    }
  };

  return (
    <section
      className="workspace-settings-section identity-bindings-panel"
      aria-labelledby="identity-bindings-title"
    >
      <div className="workspace-settings-section-heading">
        <div>
          <h3 id="identity-bindings-title">{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <Link2 size={20} aria-hidden="true" />
      </div>
      <div className="identity-contact-policy">
        <BadgeCheck size={18} aria-hidden="true" />
        <p>
          <strong>{copy.contactPolicyTitle}</strong>
          <span>{copy.contactPolicyDescription}</span>
        </p>
      </div>
      <ul className="identity-binding-list" aria-label={copy.title}>
        <li>
          <AtSign size={18} aria-hidden="true" />
          <span>
            <strong>{copy.email}</strong>
            <small>{identity.email ?? copy.unavailable}</small>
          </span>
          {identity.emailVerified ? (
            <em>{copy.bound}</em>
          ) : identity.email && identity.emailOtp ? (
            <Button
              className="min-h-11"
              size="md"
              variant="outline"
              type="button"
              disabled={loading || savingEmail}
              onClick={() => {
                if (emailCodeSent) {
                  setEmailCodeSent(false);
                  setEmailCode("");
                  return;
                }
                void sendEmailCode();
              }}
            >
              {emailCodeSent ? copy.cancel : copy.verifyEmail}
            </Button>
          ) : (
            <em>{copy.unverified}</em>
          )}
        </li>
        <li>
          <Smartphone size={18} aria-hidden="true" />
          <span>
            <strong>{copy.phone}</strong>
            <small>{identity.phoneNumber ?? copy.notBound}</small>
          </span>
          {identity.phoneNumberVerified ? (
            <em>{copy.bound}</em>
          ) : identity.phoneOtp ? (
            <Button
              className="min-h-11"
              size="md"
              variant="outline"
              type="button"
              onClick={() => {
                setPhoneOpen((open) => !open);
                setPhoneCodeSent(false);
                setPhoneCode("");
              }}
              disabled={loading}
            >
              {phoneOpen ? copy.cancel : copy.bindPhone}
            </Button>
          ) : (
            <em>{copy.notConfigured}</em>
          )}
        </li>
        {identity.providers.map((provider) => {
          const linked = identity.linkedProviders.has(provider);
          const configured = identity.configuredProviders.has(provider);
          return (
            <li key={provider}>
              <ProviderIcon provider={provider} />
              <span>
                <strong>{providerLabel(provider, locale)}</strong>
                <small>{providerDescription(provider, locale)}</small>
              </span>
              {linked ? (
                <em>{copy.bound}</em>
              ) : configured ? (
                <Button
                  className="min-h-11"
                  size="md"
                  variant="outline"
                  type="button"
                  disabled={Boolean(linkingProvider) || loading}
                  onClick={() => void linkProvider(provider)}
                >
                  {linkingProvider === provider ? (
                    <LoaderCircle
                      className="identity-binding-spinner"
                      size={16}
                      aria-hidden="true"
                    />
                  ) : null}
                  {locale === "zh"
                    ? `${copy.bindProvider}${providerLabel(provider, locale)}`
                    : `${copy.bindProvider} ${providerLabel(provider, locale)}`}
                </Button>
              ) : (
                <em>{copy.notConfigured}</em>
              )}
            </li>
          );
        })}
      </ul>
      {emailCodeSent ? (
        <form
          className="identity-phone-form"
          aria-label={copy.verifyEmail}
          onSubmit={(event) => {
            event.preventDefault();
            void confirmEmail();
          }}
        >
          <label>
            <span>{copy.code}</span>
            <input
              value={emailCode}
              onChange={(event) =>
                setEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={copy.codePlaceholder}
            />
          </label>
          <Button
            className="min-h-11"
            size="md"
            type="submit"
            variant="outline"
            disabled={savingEmail}
          >
            {savingEmail ? copy.saving : copy.confirmEmail}
          </Button>
          <Button
            className="min-h-11"
            size="md"
            type="button"
            variant="outline"
            disabled={savingEmail}
            onClick={() => void sendEmailCode()}
          >
            {copy.resendCode}
          </Button>
        </form>
      ) : null}
      {phoneOpen ? (
        <form
          className="identity-phone-form"
          aria-label={copy.bindPhone}
          onSubmit={
            phoneCodeSent
              ? (event) => {
                  event.preventDefault();
                  void confirmPhone();
                }
              : sendPhoneCode
          }
        >
          <label>
            <span>{copy.phone}</span>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
              autoComplete="tel"
              placeholder="+86 138 0000 0000"
              readOnly={phoneCodeSent}
            />
          </label>
          {phoneCodeSent ? (
            <label>
              <span>{copy.code}</span>
              <input
                value={phoneCode}
                onChange={(event) =>
                  setPhoneCode(
                    event.target.value.replace(/\D/g, "").slice(0, 6),
                  )
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={copy.codePlaceholder}
              />
            </label>
          ) : null}
          <Button
            className="min-h-11"
            size="md"
            type="submit"
            variant="outline"
            disabled={savingPhone}
          >
            {savingPhone
              ? copy.saving
              : phoneCodeSent
                ? copy.confirmPhone
                : copy.sendPhoneCode}
          </Button>
          {phoneCodeSent ? (
            <Button
              className="min-h-11"
              size="md"
              type="button"
              variant="outline"
              disabled={savingPhone}
              onClick={() => {
                setPhoneCodeSent(false);
                setPhoneCode("");
              }}
            >
              {copy.changePhone}
            </Button>
          ) : null}
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
  if (provider === "national_identity")
    return <BadgeCheck size={18} aria-hidden="true" />;
  if (provider === "wechat")
    return <MessageCircleMore size={18} aria-hidden="true" />;
  if (provider === "alipay")
    return <WalletCards size={18} aria-hidden="true" />;
  return <Link2 size={18} aria-hidden="true" />;
}

function isProviderId(provider: unknown): provider is ProviderId {
  return (
    provider === "national_identity" ||
    provider === "google" ||
    provider === "wechat" ||
    provider === "qq" ||
    provider === "alipay"
  );
}

function providerLabel(provider: ProviderId, locale: InterfaceLocale): string {
  const labels: Record<ProviderId, [string, string]> = {
    national_identity: ["网号", "National network identity"],
    wechat: ["微信", "WeChat"],
    google: ["Google", "Google"],
    qq: ["QQ", "QQ"],
    alipay: ["支付宝", "Alipay"],
  };
  return labels[provider][locale === "zh" ? 0 : 1];
}

function providerDescription(
  provider: ProviderId,
  locale: InterfaceLocale,
): string {
  const descriptions: Record<ProviderId, [string, string]> = {
    national_identity: ["国家网络身份认证", "Government network identity"],
    wechat: ["使用微信账号登录", "Sign in with WeChat"],
    alipay: ["使用支付宝账号登录", "Sign in with Alipay"],
    qq: ["使用 QQ 账号登录", "Sign in with QQ"],
    google: ["使用 Google 账号登录", "Sign in with Google"],
  };
  return descriptions[provider][locale === "zh" ? 0 : 1];
}

function identityCopy(locale: InterfaceLocale) {
  return locale === "zh"
    ? {
        title: "账号绑定",
        description:
          "网号、微信和支付宝由商城接入后即可绑定；联系方式仍只在双方同意后交换。",
        contactPolicyTitle: "联系交换只使用已验证绑定",
        contactPolicyDescription:
          "平台不再接受手填联系方式。只有你明确同意后，已验证邮箱或手机号才会交换给对方。",
        email: "邮箱",
        phone: "手机号",
        bound: "已绑定",
        unverified: "未验证",
        notBound: "未绑定",
        unavailable: "暂不可用",
        notConfigured: "商城暂未接入",
        bindPhone: "绑定手机号",
        bindProvider: "绑定",
        sendPhoneCode: "发送验证码",
        confirmPhone: "确认绑定",
        changePhone: "换个手机号",
        verifyEmail: "验证邮箱",
        confirmEmail: "确认验证",
        resendCode: "重新发送",
        cancel: "取消",
        code: "验证码",
        codePlaceholder: "6 位验证码",
        saving: "处理中…",
        phoneCodeSent: "验证码已发送到该手机号。",
        phoneBound: "手机号已验证并绑定。",
        emailCodeSent: "验证码已发送到该邮箱。",
        emailVerifiedNotice: "邮箱已验证，可用于联系交换。",
        emailFailed: "邮箱验证没有完成，请重试。",
        invalidPhone: "请输入有效的手机号。",
        invalidCode: "请输入 6 位验证码。",
        phoneFailed: "手机号绑定没有完成，请重试。",
        providerFailed: "账号绑定没有完成，请重试。",
        loadFailed: "登录方式暂时无法读取。",
      }
    : {
        title: "Linked accounts",
        description:
          "National identity, WeChat, and Alipay can be bound after the mall configures them; contact details still require mutual consent. Vehicles, payments, and contact exchange remain separate.",
        contactPolicyTitle: "Contact exchange uses verified bindings only",
        contactPolicyDescription:
          "Manual contact details are not accepted. A verified email or phone is disclosed only after you explicitly agree.",
        email: "Email",
        phone: "Phone",
        bound: "Bound",
        unverified: "Unverified",
        notBound: "Not bound",
        unavailable: "Unavailable",
        notConfigured: "Not configured by the mall",
        bindPhone: "Bind phone",
        bindProvider: "Bind",
        sendPhoneCode: "Send code",
        confirmPhone: "Confirm binding",
        changePhone: "Use another number",
        verifyEmail: "Verify email",
        confirmEmail: "Confirm code",
        resendCode: "Resend code",
        cancel: "Cancel",
        code: "Code",
        codePlaceholder: "6-digit code",
        saving: "Working…",
        phoneCodeSent: "A code was sent to this phone number.",
        phoneBound: "Phone number verified and bound.",
        emailCodeSent: "A code was sent to this email.",
        emailVerifiedNotice: "Email verified. It can now be exchanged after mutual consent.",
        emailFailed: "Email verification did not complete. Try again.",
        invalidPhone: "Enter a valid phone number.",
        invalidCode: "Enter the 6-digit code.",
        phoneFailed: "Phone binding did not complete. Try again.",
        providerFailed: "Account binding did not complete. Try again.",
        loadFailed: "Sign-in methods are temporarily unavailable.",
      };
}
