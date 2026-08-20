"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { createMarketplaceOffer, isLiveMarketplaceEnabled, submitSellerListing, type ContactExchange } from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale, InterfaceTheme } from "../lib/preferences";
import { pricingFor, subplatformCopy, type SubplatformConfig } from "../subplatform";
import type { AssetListing, WorkspaceRole } from "../types";

interface PluginHostProps {
  subplatform: SubplatformConfig;
  role: WorkspaceRole;
  theme: InterfaceTheme;
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
  fallback: ReactNode;
  /** Public result cards owned by the host. The iframe receives a bounded snapshot only. */
  listings?: AssetListing[];
  /** Open a result in the host-owned detail sheet and contact flow. */
  onOpenListing?: (listing: AssetListing) => void;
  /** Opaque conversational seller draft; the plugin may import it into its editable form. */
  sellerDraft?: {
    narrative: string;
    intentId?: string;
    attributes: Record<string, unknown>;
    terms: Record<string, unknown>;
  } | null;
  /** Let a mounted child platform own the viewport below the host back control. */
  fullscreen?: boolean;
}

/**
 * Host a verified static subplatform UI in a capability-limited iframe. The
 * plugin receives context through postMessage and can request the shared chat,
 * but it never receives a session token or payment authority. Contact updates are validated by
 * the host and forwarded through the same Better Auth session bridge as the generic workspace.
 */
export function PluginHost({ subplatform, role, theme, locale, onNotice, fallback, listings = [], onOpenListing, sellerDraft = null, fullscreen = false }: PluginHostProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const contextTokenRef = useRef<string | null>(null);
  const pluginReadyRef = useRef(false);
  const listingsRef = useRef<AssetListing[]>(listings);
  const [failed, setFailed] = useState(false);
  const artifact = subplatform.pluginArtifact;
  const copy = (key: string, fallbackText: string) => subplatformCopy(subplatform, key, fallbackText);

  listingsRef.current = listings;

  const postResults = () => {
    const frame = frameRef.current?.contentWindow;
    const contextToken = contextTokenRef.current;
    if (!pluginReadyRef.current || !frame || !contextToken) return;
    frame.postMessage({
      protocol: "matchplane.plugin/v1",
      type: "match.results",
      version: 1,
      contextToken,
      payload: { listings: listingsRef.current.slice(0, 100) },
    }, "*");
  };

  const postContext = () => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    frame.postMessage({
      protocol: "matchplane.plugin/v1",
      type: "platform.context",
      version: 1,
      payload: {
        path: subplatform.path,
        platform: subplatform.slug,
        role,
        theme,
        locale,
        contextToken: contextTokenRef.current,
        currency: subplatform.currency,
        currencyScale: subplatform.currencyScale,
        pricing: pricingFor(subplatform),
        assetSchema: subplatform.assetSchema,
        ui: subplatform.ui,
        capabilities: ["chat.open", "match.results", "listing.open", "listing.select", "listing.submit", "contact.update", "navigation"],
        ...(role === "seller" && sellerDraft ? { agentDraft: sellerDraft } : {}),
      },
    }, "*");
    // onLoad can precede plugin.ready. Messages are ordered, so the plugin can
    // consume the context before the result snapshot in either case.
    pluginReadyRef.current = true;
    postResults();
  };

  useEffect(() => {
    contextTokenRef.current = createContextToken();
    pluginReadyRef.current = false;
    const artifactOrigin = new URL(artifact?.url ?? window.location.href, window.location.href).origin;
    // `sandbox="allow-scripts"` deliberately gives the plugin an opaque `null` origin. Keep
    // that isolation instead of adding `allow-same-origin`; source + contextToken are the
    // capability boundary for this narrow postMessage protocol.
    const onMessage = (event: MessageEvent<unknown>) => {
      if ((event.origin !== "null" && event.origin !== artifactOrigin)
        || event.source !== frameRef.current?.contentWindow
        || !isRecord(event.data)) return;
      if (event.data.protocol !== "matchplane.plugin/v1") return;
      if (event.data.type === "plugin.ready") {
        postContext();
        return;
      }
      if (event.data.contextToken !== contextTokenRef.current) return;
      if (event.data.type === "chat.open") {
        document.getElementById("match-chat-input")?.focus();
        onNotice(copy("pluginChatOpenedNotice", "已打开共享 AI 撮合输入框"));
      } else if (event.data.type === "listing.select") {
        onNotice(copy("pluginSelectionNotice", "插件已提交供给选择，平台会继续按权限撮合"));
      } else if (event.data.type === "listing.open") {
        const payload = isRecord(event.data.payload) ? event.data.payload : null;
        const listingId = payload && typeof payload.listingId === "string" ? payload.listingId : null;
        const selected = listingId ? listingsRef.current.find((item) => item.id === listingId) : null;
        if (!selected) {
          onNotice(copy("pluginListingUnavailableNotice", "这条供给已不在当前匹配结果中，请重新描述需求"));
        } else if (onOpenListing) {
          onOpenListing(selected);
        }
      } else if (event.data.type === "listing.submit") {
        void submitPluginListing(event.data, {
          frame: frameRef.current?.contentWindow,
          targetOrigin: "*",
          contextToken: contextTokenRef.current,
          role,
          subplatform,
          onNotice,
        });
      } else if (event.data.type === "contact.update") {
        void updatePluginContact(event.data, {
          frame: frameRef.current?.contentWindow,
          targetOrigin: "*",
          contextToken: contextTokenRef.current,
          role,
          subplatform,
          onNotice,
        });
      } else if (event.data.type === "navigation") {
        onNotice(copy("pluginNavigationNotice", "插件导航请求已收到；平台会校验当前路径权限"));
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      pluginReadyRef.current = false;
      window.removeEventListener("message", onMessage);
    };
  }, [locale, onNotice, onOpenListing, role, subplatform, theme]);

  useEffect(() => {
    postResults();
  }, [listings]);

  useEffect(() => {
    // A routed seller draft may arrive after the iframe has already loaded. Re-send the
    // versioned context so the plugin can offer an import action without a page reload.
    if (pluginReadyRef.current) postContext();
  }, [sellerDraft]);

  if (!artifact) return null;

  return (
    <div className={`plugin-workspace${fullscreen ? " is-fullscreen" : ""}`}>
      <section className={`plugin-host${fullscreen ? " is-fullscreen" : ""}`} aria-label={`${subplatform.brandName} 插件界面`}>
        {fullscreen ? null : <div className="plugin-host-bar">
          <span>{subplatform.brandName}</span>
          <a href={artifact.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />{copy("openPluginLabel", "独立打开")}
          </a>
        </div>}
        {failed ? (
          <div className="plugin-host-fallback">
            <p role="status">{copy("pluginFallbackNotice", "插件界面暂时不可用，已回退到平台通用工作台。")}</p>
            {fallback}
          </div>
        ) : (
          <iframe
            ref={frameRef}
            className="plugin-frame"
            title={`${subplatform.brandName} ${role} 工作台`}
            src={artifact.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading={fullscreen ? "eager" : "lazy"}
            onError={() => setFailed(true)}
            onLoad={postContext}
          />
        )}
      </section>
    </div>
  );
}

async function updatePluginContact(
  message: Record<string, unknown>,
  input: {
    frame: Window | null | undefined;
    targetOrigin: string;
    contextToken: string | null;
    role: WorkspaceRole;
    subplatform: SubplatformConfig;
    onNotice: (message: string) => void;
  },
): Promise<void> {
  const requestId = typeof message.requestId === "string" ? message.requestId : null;
  const respond = (ok: boolean, error?: string) => {
    if (!requestId || !input.frame || !input.contextToken) return;
    input.frame.postMessage({
      protocol: "matchplane.plugin/v1",
      version: 1,
      type: "contact.update.result",
      requestId,
      contextToken: input.contextToken,
      ok,
      ...(error ? { error } : {}),
    }, input.targetOrigin);
  };
  try {
    if (input.role !== "buyer" && input.role !== "seller") throw new Error("只有需求方或供给方可以配置联系方式");
    if (!isLiveMarketplaceEnabled() || !input.subplatform.tenantId || !input.subplatform.domainId) {
      throw new Error("当前平台尚未连接真实联系方式服务");
    }
    if (!isRecord(message.payload) || !isRecord(message.payload.contact)) throw new Error("联系方式必须是 JSON 对象");
    const contact: ContactExchange = {};
    for (const [key, value] of Object.entries(message.payload.contact)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || typeof value !== "string" || !value.trim() || value.length > 256) {
        throw new Error("联系方式渠道名称或内容格式无效");
      }
      contact[key] = value.trim();
    }
    if (!Object.keys(contact).length) throw new Error("至少填写一种联系方式");
    const session = await getMarketplaceSession({
      subplatform: input.subplatform.slug,
      platformPath: input.subplatform.path,
      tenantId: input.subplatform.tenantId,
      domainId: input.subplatform.domainId,
      role: input.role,
      forceRefresh: true,
      contact,
      preserveContact: false,
    });
    if (!session) throw new Error("请先登录后保存联系方式");
    input.onNotice(subplatformCopy(input.subplatform, "contactProfileSavedNotice", "联系方式已加密保存；双方同意后才会交换"));
    respond(true);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "联系方式保存失败，请稍后重试";
    input.onNotice(messageText);
    respond(false, messageText);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function submitPluginListing(
  message: Record<string, unknown>,
  input: {
    frame: Window | null | undefined;
    targetOrigin: string;
    contextToken: string | null;
    role: WorkspaceRole;
    subplatform: SubplatformConfig;
    onNotice: (message: string) => void;
  },
): Promise<void> {
  const requestId = typeof message.requestId === "string" ? message.requestId : null;
  const respond = (ok: boolean, error?: string) => {
    if (!requestId || !input.frame || !input.contextToken) return;
    input.frame.postMessage({
      protocol: "matchplane.plugin/v1",
      version: 1,
      type: "listing.submit.result",
      requestId,
      contextToken: input.contextToken,
      ok,
      ...(error ? { error } : {}),
    }, input.targetOrigin);
  };

  try {
    if (input.role !== "seller") throw new Error(subplatformCopy(input.subplatform, "supplyOnlyError", "只有供给方可以提交资料"));
    if (!isLiveMarketplaceEnabled()) throw new Error("插件供给提交需要连接真实平台 API");
    if (!input.subplatform.tenantId || !input.subplatform.domainId) {
      throw new Error("当前子平台尚未发布完整的身份配置");
    }
    if (!isRecord(message.payload)) throw new Error("插件供给资料格式无效");
    const supply = message.payload;
    const attributes = supply.attributes;
    if (!isRecord(attributes)) throw new Error("供给 attributes 必须是 JSON 对象");
    const externalKey = typeof supply.externalKey === "string" && supply.externalKey.trim()
      ? boundedText(supply.externalKey, 256, "内部编号")
      : `offer-${crypto.randomUUID()}`;
    const displayName = boundedText(supply.displayName, 500, "供给名称");
    const pricing = pricingFor(input.subplatform);
    const usesLegacyMarketplace = input.subplatform.marketplaceContract === "legacy-v1";
    const askingAmount = typeof supply.askingAmount === "string" ? supply.askingAmount.trim() : "";
    const currency = typeof supply.currency === "string" ? supply.currency.trim().toUpperCase() : "";
    if (pricing.mode === "fixed") {
      if (!pricing.currency) throw new Error("当前子平台尚未发布完整的结算配置");
      if (!/^\d+$/.test(askingAmount)) throw new Error("报价必须是非负整数（最小货币单位）");
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("币种必须是三位大写 ISO 4217 代码");
    }
    if (usesLegacyMarketplace && !input.subplatform.assetSchemaId) {
      throw new Error("兼容适配器尚未发布完整的资料 schema");
    }
    if (JSON.stringify(attributes).length > 64_000) throw new Error("供给 attributes 不能超过 64KB");

    const session = await getMarketplaceSession({
      subplatform: input.subplatform.slug,
      platformPath: input.subplatform.path,
      tenantId: input.subplatform.tenantId,
      domainId: input.subplatform.domainId,
      role: "seller",
    });
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      input.onNotice(subplatformCopy(input.subplatform, "supplyLoginNotice", "请先登录供给方账号，登录后会回到当前子平台"));
      window.location.assign(`/login?role=seller&next=${encodeURIComponent(next)}`);
      throw new Error("Better Auth 会话尚未建立");
    }

    if (usesLegacyMarketplace) {
      await submitSellerListing({
        session,
        domainId: input.subplatform.domainId,
        assetSchemaId: input.subplatform.assetSchemaId as string,
        externalKey,
        displayName,
        attributes,
        askingAmount,
        currency,
        currencyScale: pricing.currencyScale ?? input.subplatform.currencyScale ?? 0,
      });
    } else {
      await createMarketplaceOffer({
        session,
        domainId: input.subplatform.domainId,
        externalKey,
        displayName,
        attributes,
        terms: {
          pricing_mode: pricing.mode,
          ...(askingAmount ? { amount_minor: askingAmount } : {}),
          ...(currency ? { currency } : {}),
          ...(pricing.currencyScale !== undefined ? { currency_scale: pricing.currencyScale } : {}),
          ...(pricing.label ? { pricing_label: pricing.label } : {}),
        },
      });
    }
    input.onNotice(subplatformCopy(input.subplatform, "pluginSubmissionSuccess", "供给已真实提交，等待子平台审核后进入 AI 撮合"));
    respond(true);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "供给提交失败，请稍后重试";
    input.onNotice(messageText);
    respond(false, messageText);
  }
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label}必须是长度 1..${maximum} 的文本`);
  }
  return value.trim();
}

function createContextToken(): string {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("当前运行环境不支持安全的插件上下文令牌");
  }
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
