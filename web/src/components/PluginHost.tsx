"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import {
  createMarketplaceOffer,
  isLiveMarketplaceEnabled,
  submitSellerListing,
  type MarketplaceAttachment,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale, InterfaceTheme } from "../lib/preferences";
import {
  pricingFor,
  subplatformCopy,
  type SubplatformConfig,
} from "../subplatform";
import type { AssetListing, WorkspaceRole } from "../types";

// The script-only sandbox intentionally has an opaque `null` origin, so postMessage cannot name
// its origin. Messages still target one exact Window; inbound actions additionally require that
// Window as their source and a per-mount capability token.
const OPAQUE_SANDBOX_TARGET_ORIGIN = "*";

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
  /** Apply a host-owned authenticated like without exposing a session to the iframe. */
  onLikeListing?: (listing: AssetListing) => Promise<void>;
  /** Open the host-owned demand conversation on the current child platform. */
  onOpenDemand?: () => void;
  /** Start the root Better Auth flow while preserving the current child path. */
  onAuthRequired?: () => void;
  /** Coarse auth state only; user identity and session material never cross the bridge. */
  authStatus?: "pending" | "authenticated" | "anonymous";
  /** Opaque conversational seller draft; the plugin may import it into its editable form. */
  sellerDraft?: {
    narrative: string;
    intentId?: string;
    attributes: Record<string, unknown>;
    terms: Record<string, unknown>;
    attachments?: MarketplaceAttachment[];
  } | null;
  /** Let a mounted child platform own the viewport below the host back control. */
  fullscreen?: boolean;
  /** Restore the host workspace when the plugin asset cannot load. */
  onFailure?: () => void;
}

/**
 * Host a verified static subplatform UI in a capability-limited iframe. The
 * plugin receives context through postMessage and can request the shared chat,
 * but it never receives a session token, payment authority, or contact-entry capability.
 * Hostile legacy contact.update messages are rejected below as a defense-in-depth boundary.
 */
export function PluginHost({
  subplatform,
  role,
  theme,
  locale,
  onNotice,
  fallback,
  listings = [],
  onOpenListing,
  onLikeListing,
  onOpenDemand,
  onAuthRequired,
  authStatus = "anonymous",
  sellerDraft = null,
  fullscreen = false,
  onFailure,
}: PluginHostProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const contextTokenRef = useRef<string | null>(null);
  const pluginReadyRef = useRef(false);
  const listingsRef = useRef<AssetListing[]>(listings);
  const [failed, setFailed] = useState(false);
  const artifact = subplatform.pluginArtifact;
  const copy = (key: string, fallbackText: string) =>
    subplatformCopy(subplatform, key, fallbackText);

  listingsRef.current = listings;

  const postResults = () => {
    const frame = frameRef.current?.contentWindow;
    const contextToken = contextTokenRef.current;
    if (!pluginReadyRef.current || !frame || !contextToken) return;
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    frame.postMessage(
      {
        protocol: "matchplane.plugin/v1",
        type: "match.results",
        version: 1,
        contextToken,
        payload: { listings: listingsRef.current.slice(0, 100) },
      },
      OPAQUE_SANDBOX_TARGET_ORIGIN,
    );
  };

  const postContext = () => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    frame.postMessage(
      {
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
          auth: { status: authStatus },
          currency: subplatform.currency,
          currencyScale: subplatform.currencyScale,
          pricing: pricingFor(subplatform),
          assetSchema: subplatform.assetSchema,
          ui: subplatform.ui,
          capabilities: pluginCapabilitiesForRole(role, fullscreen),
          ...(role === "seller" && sellerDraft
            ? { agentDraft: sellerDraft }
            : {}),
        },
      },
      OPAQUE_SANDBOX_TARGET_ORIGIN,
    );
    // onLoad can precede plugin.ready. Messages are ordered, so the plugin can
    // consume the context before the result snapshot in either case.
    pluginReadyRef.current = true;
    postResults();
  };

  useEffect(() => {
    contextTokenRef.current = createContextToken();
    pluginReadyRef.current = false;
    const artifactOrigin = new URL(
      artifact?.url ?? window.location.href,
      window.location.href,
    ).origin;
    // `sandbox="allow-scripts"` deliberately gives the plugin an opaque `null` origin. Keep
    // that isolation instead of adding `allow-same-origin`; source + contextToken are the
    // capability boundary for this narrow postMessage protocol.
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        (event.origin !== "null" && event.origin !== artifactOrigin) ||
        event.source !== frameRef.current?.contentWindow ||
        !isRecord(event.data)
      )
        return;
      if (event.data.protocol !== "matchplane.plugin/v1") return;
      if (event.data.type === "plugin.ready") {
        postContext();
        return;
      }
      if (event.data.contextToken !== contextTokenRef.current) return;
      if (
        event.data.type === "chat.open" ||
        event.data.type === "demand.open"
      ) {
        if (onOpenDemand) {
          onOpenDemand();
          onNotice(copy("pluginChatOpenedNotice", "已打开店内 AI 选货员"));
          pluginResponder(
            event.data,
            pluginActionInput(),
            event.data.type === "chat.open"
              ? "chat.open.result"
              : "demand.open.result",
          )(true);
          return;
        }
        if (fullscreen) {
          onNotice(
            copy("pluginChatUnavailableNotice", "请返回上一级继续描述需求"),
          );
          return;
        }
        document.getElementById("match-chat-input")?.focus();
        onNotice(copy("pluginChatOpenedNotice", "已打开找商品输入框"));
      } else if (event.data.type === "auth.open") {
        if (onAuthRequired) onAuthRequired();
        pluginResponder(
          event.data,
          pluginActionInput(),
          "auth.open.result",
        )(Boolean(onAuthRequired), onAuthRequired ? undefined : "unavailable");
      } else if (
        event.data.type === "listing.open" ||
        event.data.type === "listing.like"
      ) {
        const selected = listingForPluginAction(
          event.data,
          listingsRef.current,
        );
        if (!selected) {
          const messageText = copy(
            "pluginListingUnavailableNotice",
            "这条供给已不在当前匹配结果中，请重新描述需求",
          );
          onNotice(messageText);
          pluginResponder(
            event.data,
            pluginActionInput(),
            event.data.type === "listing.like"
              ? "listing.like.result"
              : "listing.open.result",
          )(false, messageText);
        } else if (event.data.type === "listing.open") {
          onOpenListing?.(selected);
          pluginResponder(
            event.data,
            pluginActionInput(),
            "listing.open.result",
          )(Boolean(onOpenListing), onOpenListing ? undefined : "unavailable");
        } else if (onLikeListing) {
          const message = event.data;
          void onLikeListing(selected)
            .then(() =>
              pluginResponder(
                message,
                pluginActionInput(),
                "listing.like.result",
              )(true),
            )
            .catch(() => {
              const messageText = copy(
                "pluginLikeFailedNotice",
                "点赞暂时失败，请稍后重试",
              );
              onNotice(messageText);
              pluginResponder(
                message,
                pluginActionInput(),
                "listing.like.result",
              )(false, messageText);
            });
        } else {
          pluginResponder(
            event.data,
            pluginActionInput(),
            "listing.like.result",
          )(false, "unavailable");
        }
      } else if (event.data.type === "listing.submit") {
        if (role !== "seller") {
          const messageText = copy(
            "pluginSellerCapabilityRequired",
            "只有已授权卖家工作区可以提交商品",
          );
          onNotice(messageText);
          pluginResponder(
            event.data,
            {
              frame: frameRef.current?.contentWindow,
              targetOrigin: OPAQUE_SANDBOX_TARGET_ORIGIN,
              contextToken: contextTokenRef.current,
              role,
              subplatform,
              onNotice,
            },
            "listing.submit.result",
          )(false, messageText);
          return;
        }
        void submitPluginListing(event.data, {
          frame: frameRef.current?.contentWindow,
          targetOrigin: OPAQUE_SANDBOX_TARGET_ORIGIN,
          contextToken: contextTokenRef.current,
          role,
          subplatform,
          onNotice,
        });
      } else if (event.data.type === "contact.update") {
        void updatePluginContact(event.data, {
          frame: frameRef.current?.contentWindow,
          targetOrigin: OPAQUE_SANDBOX_TARGET_ORIGIN,
          contextToken: contextTokenRef.current,
          role,
          subplatform,
          onNotice,
        });
      }
    };
    function pluginActionInput(): PluginActionInput {
      return {
        frame: frameRef.current?.contentWindow,
        targetOrigin: OPAQUE_SANDBOX_TARGET_ORIGIN,
        contextToken: contextTokenRef.current,
        role,
        subplatform,
        onNotice,
      };
    }

    window.addEventListener("message", onMessage);
    return () => {
      pluginReadyRef.current = false;
      window.removeEventListener("message", onMessage);
    };
  }, [
    authStatus,
    fullscreen,
    locale,
    onAuthRequired,
    onLikeListing,
    onNotice,
    onOpenDemand,
    onOpenListing,
    role,
    subplatform,
    theme,
  ]);

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
      <section
        className={`plugin-host${fullscreen ? " is-fullscreen" : ""}`}
        aria-label={`${subplatform.brandName} 插件界面`}
      >
        {fullscreen ? null : (
          <div className="plugin-host-bar">
            <span>{subplatform.brandName}</span>
            <a href={artifact.url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} aria-hidden="true" />
              {copy("openPluginLabel", "独立打开")}
            </a>
          </div>
        )}
        {failed ? (
          <div className="plugin-host-fallback">
            <p role="status">
              {copy(
                "pluginFallbackNotice",
                "插件界面暂时不可用，已回退到平台通用工作台。",
              )}
            </p>
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
            onError={() => {
              setFailed(true);
              onFailure?.();
            }}
            onLoad={postContext}
          />
        )}
      </section>
    </div>
  );
}

export function pluginCapabilitiesForRole(
  role: WorkspaceRole,
  fullscreen: boolean,
): string[] {
  const capabilities = ["match.results", "listing.open"];
  if (!fullscreen) capabilities.unshift("chat.open");
  if (role === "buyer") {
    capabilities.push("auth.open", "demand.open", "listing.like");
  }
  if (role === "seller") capabilities.push("listing.submit");
  return capabilities;
}

interface PluginActionInput {
  frame: Window | null | undefined;
  targetOrigin: string;
  contextToken: string | null;
  role: WorkspaceRole;
  subplatform: SubplatformConfig;
  onNotice: (message: string) => void;
}

function updatePluginContact(
  message: Record<string, unknown>,
  input: PluginActionInput,
): void {
  const messageText = subplatformCopy(
    input.subplatform,
    "contactProfileIdentityBindingRequired",
    "联系方式只能在账号设置中绑定并验证，不能由店铺或插件手动填写",
  );
  input.onNotice(messageText);
  pluginResponder(message, input, "contact.update.result")(false, messageText);
}

function listingForPluginAction(
  message: Record<string, unknown>,
  listings: AssetListing[],
): AssetListing | null {
  const payload = isRecord(message.payload) ? message.payload : null;
  const listingId =
    payload && typeof payload.listingId === "string" ? payload.listingId : null;
  if (!listingId) return null;
  return (
    listings.find(
      (item) => item.id === listingId || item.offerId === listingId,
    ) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function submitPluginListing(
  message: Record<string, unknown>,
  input: PluginActionInput,
): Promise<void> {
  const respond = pluginResponder(message, input, "listing.submit.result");

  try {
    if (input.role !== "seller")
      throw new Error("只有已授权卖家工作区可以提交商品");
    if (!isLiveMarketplaceEnabled())
      throw new Error("插件供给提交需要连接真实平台 API");
    if (!input.subplatform.tenantId || !input.subplatform.domainId) {
      throw new Error("当前店铺尚未发布完整的身份配置");
    }
    if (!isRecord(message.payload)) throw new Error("插件供给资料格式无效");
    const supply = message.payload;
    const attributes = supply.attributes;
    if (!isRecord(attributes))
      throw new Error("供给 attributes 必须是 JSON 对象");
    const externalKey =
      typeof supply.externalKey === "string" && supply.externalKey.trim()
        ? boundedText(supply.externalKey, 256, "内部编号")
        : `offer-${crypto.randomUUID()}`;
    const displayName = boundedText(supply.displayName, 500, "供给名称");
    const pricing = pricingFor(input.subplatform);
    const usesLegacyMarketplace =
      input.subplatform.marketplaceContract === "legacy-v1";
    const askingAmount =
      typeof supply.askingAmount === "string" ? supply.askingAmount.trim() : "";
    const currency =
      typeof supply.currency === "string"
        ? supply.currency.trim().toUpperCase()
        : "";
    if (pricing.mode === "fixed") {
      if (!pricing.currency) throw new Error("当前店铺尚未发布完整的价格配置");
      if (!/^\d+$/.test(askingAmount))
        throw new Error("报价必须是非负整数（最小货币单位）");
      if (!/^[A-Z]{3}$/.test(currency))
        throw new Error("币种必须是三位大写 ISO 4217 代码");
    }
    if (usesLegacyMarketplace && !input.subplatform.assetSchemaId) {
      throw new Error("兼容适配器尚未发布完整的资料 schema");
    }
    if (JSON.stringify(attributes).length > 64_000)
      throw new Error("供给 attributes 不能超过 64KB");

    const session = await getMarketplaceSession({
      subplatform: input.subplatform.slug,
      platformPath: input.subplatform.path,
      tenantId: input.subplatform.tenantId,
      domainId: input.subplatform.domainId,
      role: "seller",
    });
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      input.onNotice(
        subplatformCopy(
          input.subplatform,
          "supplyLoginNotice",
          "请先登录，登录后会回到当前店铺",
        ),
      );
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
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
        currencyScale:
          pricing.currencyScale ?? input.subplatform.currencyScale ?? 0,
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
          ...(pricing.currencyScale === undefined
            ? {}
            : { currency_scale: pricing.currencyScale }),
          ...(pricing.label ? { pricing_label: pricing.label } : {}),
        },
      });
    }
    input.onNotice(
      subplatformCopy(
        input.subplatform,
        "pluginSubmissionSuccess",
        "商品已提交，等待店铺审核后进入商城检索",
      ),
    );
    respond(true);
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "供给提交失败，请稍后重试";
    input.onNotice(messageText);
    respond(false, messageText);
  }
}

function pluginResponder(
  message: Record<string, unknown>,
  input: PluginActionInput,
  type:
    | "auth.open.result"
    | "chat.open.result"
    | "contact.update.result"
    | "demand.open.result"
    | "listing.like.result"
    | "listing.open.result"
    | "listing.submit.result",
): (ok: boolean, error?: string) => void {
  const requestId =
    typeof message.requestId === "string" ? message.requestId : null;
  return (ok, error) => {
    if (!requestId || !input.frame || !input.contextToken) return;
    input.frame.postMessage(
      {
        protocol: "matchplane.plugin/v1",
        version: 1,
        type,
        requestId,
        contextToken: input.contextToken,
        ok,
        ...(error ? { error } : {}),
      },
      input.targetOrigin,
    );
  };
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label}必须是长度 1..${maximum} 的文本`);
  }
  return value.trim();
}

function createContextToken(): string {
  if (
    typeof crypto === "undefined" ||
    typeof crypto.getRandomValues !== "function"
  ) {
    throw new Error("当前运行环境不支持安全的插件上下文令牌");
  }
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
