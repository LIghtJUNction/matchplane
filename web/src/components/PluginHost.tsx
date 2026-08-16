"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";

import { isLiveMarketplaceEnabled, submitSellerListing } from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { SubplatformConfig } from "../subplatform";
import type { WorkspaceRole } from "../types";

interface PluginHostProps {
  subplatform: SubplatformConfig;
  role: WorkspaceRole;
  onNotice: (message: string) => void;
  fallback: ReactNode;
}

/**
 * Host a verified static subplatform UI in a capability-limited iframe. The
 * plugin receives context through postMessage and can request the shared chat,
 * but it never receives a session token or payment/contact authority.
 */
export function PluginHost({ subplatform, role, onNotice, fallback }: PluginHostProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const contextTokenRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const artifact = subplatform.pluginArtifact;

  const postContext = () => {
    frameRef.current?.contentWindow?.postMessage({
      protocol: "matchplane.plugin/v1",
      type: "platform.context",
      version: 1,
      payload: {
        path: subplatform.path,
        platform: subplatform.slug,
        role,
        contextToken: contextTokenRef.current,
        currency: subplatform.currency,
        currencyScale: subplatform.currencyScale,
        assetSchema: subplatform.assetSchema,
        ui: subplatform.ui,
        capabilities: ["chat.open", "listing.select", "listing.submit", "navigation"],
      },
    }, "*");
  };

  useEffect(() => {
    contextTokenRef.current = createContextToken();
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
        onNotice("已打开共享 AI 撮合输入框");
      } else if (event.data.type === "listing.select") {
        onNotice("插件已提交供给选择，平台会继续按权限撮合");
      } else if (event.data.type === "listing.submit") {
        void submitPluginListing(event.data, {
          frame: frameRef.current?.contentWindow,
          targetOrigin: "*",
          contextToken: contextTokenRef.current,
          role,
          subplatform,
          onNotice,
        });
      } else if (event.data.type === "navigation") {
        onNotice("插件导航请求已收到；平台会校验当前路径权限");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onNotice, role, subplatform]);

  if (!artifact) return null;

  return (
    <div className="plugin-workspace">
      <section className="plugin-host" aria-label={`${subplatform.brandName} 插件界面`}>
        <div className="plugin-host-bar">
          <span><ShieldCheck size={15} aria-hidden="true" />已验证静态插件</span>
          <small>{artifact.digest.slice(0, 12)}…</small>
          <a href={artifact.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />独立打开
          </a>
        </div>
        {failed ? (
          <div className="plugin-host-fallback">
            <p role="status">插件界面暂时不可用，已回退到平台通用工作台。</p>
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
            loading="lazy"
            onError={() => setFailed(true)}
            onLoad={postContext}
          />
        )}
      </section>
    </div>
  );
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
    if (input.role !== "seller") throw new Error("只有供给方可以提交资料");
    if (!isLiveMarketplaceEnabled()) throw new Error("插件供给提交需要连接真实平台 API");
    if (!input.subplatform.tenantId || !input.subplatform.domainId || !input.subplatform.assetSchemaId || !input.subplatform.currency) {
      throw new Error("当前子平台尚未发布完整的资料 schema 与结算配置");
    }
    if (!isRecord(message.payload)) throw new Error("插件供给资料格式无效");
    const supply = message.payload;
    const attributes = supply.attributes;
    if (!isRecord(attributes)) throw new Error("供给 attributes 必须是 JSON 对象");
    const externalKey = boundedText(supply.externalKey, 256, "内部编号");
    const displayName = boundedText(supply.displayName, 500, "供给名称");
    const askingAmount = boundedText(supply.askingAmount, 38, "报价");
    const currency = boundedText(supply.currency, 3, "币种").toUpperCase();
    if (!/^\d+$/.test(askingAmount)) throw new Error("报价必须是非负整数（最小货币单位）");
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("币种必须是三位大写 ISO 4217 代码");
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
      input.onNotice("请先登录供给方账号，登录后会回到当前子平台");
      window.location.assign(`/login?role=seller&next=${encodeURIComponent(next)}`);
      throw new Error("Better Auth 会话尚未建立");
    }

    await submitSellerListing({
      session,
      domainId: input.subplatform.domainId,
      assetSchemaId: input.subplatform.assetSchemaId,
      externalKey,
      displayName,
      attributes,
      askingAmount,
      currency,
      currencyScale: input.subplatform.currencyScale ?? 0,
    });
    input.onNotice("供给已真实提交，等待子平台审核后进入 AI 撮合");
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
