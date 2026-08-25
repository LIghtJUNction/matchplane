"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed } from "lucide-react";

import { SectionHeading } from "./Primitives";

interface AuthProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  hint?: string;
  envKeys?: string[];
  callbackUrl?: string;
}

export function AuthProvidersPanel({
  locale = "zh",
}: {
  locale?: "zh" | "en";
}) {
  const [providers, setProviders] = useState<AuthProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/admin/auth-providers")
      .then(async (response) => {
        if (!response.ok) throw new Error("读取失败");
        const body = (await response.json()) as {
          providers: AuthProviderStatus[];
        };
        if (active) {
          setProviders(body.providers);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <SectionHeading
        eyebrow={locale === "en" ? "ACCESS" : "账号接入"}
        title={locale === "en" ? "Login providers" : "登录方式"}
      />
      <p className="pb-1 text-sm text-foreground-muted">
        {locale === "en"
          ? "Each provider is activated only when its server-side credential is configured. Credentials never reach the browser."
          : "每个登录方式仅在服务端凭据配置完成后启用；浏览器永远看不到密钥内容。"}
      </p>
      {loading ? (
        <p className="py-6 text-sm text-foreground-muted" role="status">
          {locale === "en"
            ? "Loading provider status…"
            : "正在读取登录方式状态…"}
        </p>
      ) : failed ? (
        <div className="py-6 text-sm text-foreground-muted" role="alert">
          {locale === "en"
            ? "Unable to load provider status. You may not be signed in as a marketplace admin."
            : "登录方式状态读取失败；请确认当前账号是商城管理员。"}
        </div>
      ) : (
        <ul className="mt-2 grid list-none gap-0.5 p-0">
          {providers.map((provider) => (
            <li key={provider.id} className="flex flex-col gap-0.5 py-1.5">
              <div className="flex items-center gap-2">
                {provider.configured ? (
                  <CheckCircle2
                    className="size-4 shrink-0 text-foreground-strong"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleDashed
                    className="size-4 shrink-0 text-foreground-muted"
                    aria-hidden="true"
                  />
                )}
                <strong className="text-sm font-semibold text-foreground-intense">
                  {provider.label}
                </strong>
                <span
                  className={
                    provider.configured
                      ? "text-xs text-foreground-strong"
                      : "text-xs text-foreground-muted"
                  }
                >
                  {provider.configured
                    ? locale === "en"
                      ? "Configured"
                      : "已配置"
                    : locale === "en"
                      ? "Not configured"
                      : "未配置"}
                </span>
              </div>
              {provider.callbackUrl ? (
                <p className="ml-6 break-all text-xs text-foreground-muted">
                  <span className="font-medium">
                    {locale === "en" ? "Callback URL: " : "回调地址："}
                  </span>
                  <code>{provider.callbackUrl}</code>
                </p>
              ) : null}
              {provider.hint ? (
                <p className="ml-6 text-xs text-foreground-muted">
                  {provider.hint}
                </p>
              ) : null}
              {provider.envKeys ? (
                <p className="ml-6 break-all text-xs text-foreground-muted">
                  <span className="font-medium">
                    {locale === "en" ? "Env keys: " : "环境变量："}
                  </span>
                  <code>{provider.envKeys.join(", ")}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
