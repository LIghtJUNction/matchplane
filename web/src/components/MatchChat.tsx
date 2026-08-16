"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowUp, LockKeyhole, Sparkles } from "lucide-react";

import {
  createMarketplaceIntent,
  createBuyerRequest,
  getMarketplaceOfferMatches,
  getBuyerRecommendations,
  isLiveMarketplaceEnabled,
  type RecommendedBackendListing,
  routePlatformIntent,
  type PartySession,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { loadSubplatform, pricingFor, subplatformCopy, type SubplatformConfig } from "../subplatform";

const PENDING_CHAT_KEY = "matchplane.pending-chat";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface PendingChat {
  text: string;
  next: string;
}

interface ChatCopy {
  buyerEyebrow: string;
  sellerEyebrow: string;
  buyerTitle: string;
  sellerTitle: string;
  buyerDescription: string;
  sellerDescription: string;
  buyerPlaceholder: string;
  sellerPlaceholder: string;
  buyerFootnote: string;
  sellerFootnote: string;
  buyerPending: string;
  sellerPending: string;
  buyerSuccess: string;
  sellerSuccess: string;
}

const defaultChatCopy: ChatCopy = {
  buyerEyebrow: "需求方入口",
  sellerEyebrow: "供给方入口",
  buyerTitle: "先说说你想解决什么。",
  sellerTitle: "说说你能提供什么。",
  buyerDescription: "描述目标、预算、时间和不能妥协的条件，平台会把需求交给合适的供给方。",
  sellerDescription: "描述你能提供的内容、交付条件和限制，平台会把资料交给合适的需求方。",
  buyerPlaceholder: "例如：我想解决一个具体问题，预算、时间和不能妥协的条件是……",
  sellerPlaceholder: "例如：我能提供什么，交付条件和限制是……",
  buyerFootnote: "联系方式只在双方同意后交换；线下成交也会保留平台撮合记录。",
  sellerFootnote: "资料审核通过后才会展示；联系方式只在双方同意后交换。",
  buyerPending: "我先把你的目标、限制和优先级整理成一份匹配需求。",
  sellerPending: "我先把你的供给、条件和限制整理成一份资料。",
  buyerSuccess: "需求已发送，撮合会围绕你的真实目标展开",
  sellerSuccess: "供给描述已整理；请在下方提交资料，提交后才会写入系统",
};

function resolveChatCopy(subplatform: SubplatformConfig): ChatCopy {
  const configured = subplatform.ui?.chat ?? {};
  return Object.fromEntries(Object.entries(defaultChatCopy).map(([key, fallback]) => [key, configured[key] || fallback])) as ChatCopy;
}

interface MatchChatProps {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
  role?: "buyer" | "seller";
  onRecommendations?: (recommendations: RecommendedBackendListing[]) => void;
}

export function MatchChat({ onNotice, subplatform, role = "buyer", onRecommendations }: MatchChatProps) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const isRoot = subplatform.slug === "root";
  const isSeller = role === "seller";
  const copy = resolveChatCopy(subplatform);
  const label = (key: string, fallback: string) => subplatformCopy(subplatform, key, fallback);

  const submitMessage = useCallback(
    async (rawText: string, session?: PartySession) => {
      const text = rawText.trim();
      if (!text || sending) return;

      setSending(true);
      setMessage("");
      const requestId = `chat-${Date.now()}`;
      setMessages((current) => [
        ...current,
        { id: `${requestId}-user`, role: "user", text },
        {
          id: `${requestId}-assistant`,
          role: "assistant",
          text: isSeller ? copy.sellerPending : copy.buyerPending,
        },
      ]);

      try {
        const live = isLiveMarketplaceEnabled();
        if (!live) {
          const message = isSeller
            ? "当前环境未连接真实供给 API，内容没有写入系统。请先启用平台 API 后再发送。"
            : "当前环境未连接真实撮合 API，内容没有写入系统。请先启用平台 API 后再发送。";
          setMessages((current) => current.map((item) => item.id === `${requestId}-assistant` ? { ...item, text: message } : item));
          onNotice(message);
          return;
        }
        const route = live
          ? await routePlatformIntent({ platformPath: platformPath(subplatform), narrative: text })
          : null;
        const routedRecommendations: RecommendedBackendListing[] = [];
        if (live) {
          // The root and every child use the same generic marketplace transport. A route plan is
          // an allow-listed set of target nodes chosen by the platform Agent; send the request
          // to each selected node instead of recording it only at the page the user happened to
          // open. Each target receives its own Better Auth-derived capability and domain scope.
          const targets = route?.routePlan.length ? route.routePlan : [null];
          for (const hop of targets) {
            const target = hop
              ? {
                  ...(await loadSubplatform(hop.path)),
                  slug: hop.slug,
                  path: hop.path,
                  tenantId: hop.tenantId,
                  domainId: hop.domainId,
                }
              : subplatform;
            if (!target.domainId) continue;
            const targetDomainId = target.domainId;
            const targetSession = hop
              ? await getMarketplaceSession({
                  subplatform: target.slug,
                  platformPath: target.path,
                  tenantId: target.tenantId,
                  domainId: targetDomainId,
                  role,
                })
              : session;
            if (!targetSession) throw new Error("Better Auth 会话尚未连接到当前平台节点");
            const targetPricing = pricingFor(target);
            const targetUsesLegacy = target.marketplaceContract === "legacy-v1";
            const targetKey = target.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 96) || "root";
            if (isSeller) {
              await createMarketplaceIntent({
                session: targetSession,
                domainId: targetDomainId,
                side: "supply",
                narrative: text,
                attributes: {
                  source: "conversation",
                  platform_path: target.path,
                  delegated_route_count: route?.routePlan.length ?? 0,
                  routing_source: route?.routing.source ?? null,
                  routing_degraded: route?.routing.degraded ?? false,
                },
                terms: {
                  pricing_mode: targetPricing.mode,
                  ...(targetPricing.currency ? { currency: targetPricing.currency } : {}),
                  ...(targetPricing.currencyScale !== undefined ? { currency_scale: targetPricing.currencyScale } : {}),
                },
                idempotencyKey: `chat-${requestId}-${targetKey}`,
              });
            } else if (targetUsesLegacy) {
              if (!targetPricing.currency) throw new Error(`${target.label || target.slug} 尚未配置结算币种，暂时不能生成真实推荐`);
              const buyerRequest = await createBuyerRequest({
                session: targetSession,
                domainId: targetDomainId,
                narrative: text,
                requirements: {
                  source: "conversation",
                  platform_path: target.path,
                  delegated_route_count: route?.routePlan.length ?? 0,
                  routing_source: route?.routing.source ?? null,
                  routing_degraded: route?.routing.degraded ?? false,
                },
                currency: targetPricing.currency,
                currencyScale: targetPricing.currencyScale ?? 0,
              });
              const recommendations = await getBuyerRecommendations({
                session: targetSession,
                domainId: targetDomainId,
                requestId: buyerRequest.request_id,
                exposureKey: `chat-${requestId}-${targetKey}`,
              });
              routedRecommendations.push(...recommendations.map((item) => ({
                ...item,
                platform_path: target.path,
                subplatform: target.slug,
              })));
            } else {
              const intent = await createMarketplaceIntent({
                session: targetSession,
                domainId: targetDomainId,
                side: "demand",
                narrative: text,
                attributes: {},
                terms: {
                  pricing_mode: targetPricing.mode,
                  ...(targetPricing.currency ? { currency: targetPricing.currency } : {}),
                  ...(targetPricing.currencyScale !== undefined ? { currency_scale: targetPricing.currencyScale } : {}),
                },
                idempotencyKey: `chat-${requestId}-${targetKey}`,
              });
              const candidates = await getMarketplaceOfferMatches({
                session: targetSession,
                domainId: targetDomainId,
                intentId: intent.intent_id,
              });
              routedRecommendations.push(...candidates.map((candidate) => ({
                ...candidate,
                tenant_id: target.tenantId ?? candidate.tenant_id,
                domain_id: targetDomainId,
                platform_path: target.path,
                subplatform: target.slug,
                offer_id: candidate.offer_id,
                match_score: candidate.score,
                match_reasons: candidate.reasons,
                intent_id: intent.intent_id,
              })));
            }
          }
          if (routedRecommendations.length) onRecommendations?.(routedRecommendations);
        }
        setMessages((current) => current.map((item) => item.id === `${requestId}-assistant`
          ? {
              ...item,
              text: isSeller
                ? copy.sellerSuccess
                : live
                  ? route?.status === "degraded" && route.routePlan.length
                    ? `AI 路由暂时不可用，已按受控策略把需求交给 ${route.routePlan.map((hop) => hop.displayName).join("、")}；下级平台会继续筛选商家与具体供给。`
                    : route?.routePlan.length
                      ? `AI 已从当前节点的候选平台中选出 ${route.routePlan.map((hop) => hop.displayName).join("、")}，接下来由下级平台继续挑选商家与具体供给，并解释匹配理由。`
                      : route?.routing.source === "ai"
                        ? "需求已记录在当前平台节点；AI 判断当前候选平台暂时没有合适的匹配。你可以补充目标、预算或限制条件后重试。"
                        : "需求已记录在当前平台节点，当前没有已激活的下级平台；管理员启用子平台后会继续向下传递。"
                  : "需求已记录在当前平台节点。",
          }
          : item));
        onNotice(isSeller ? copy.sellerSuccess : copy.buyerSuccess);
        if (isSeller) window.setTimeout(() => document.getElementById("seller-display-name")?.focus(), 0);
      } catch (error) {
        setMessages((current) => current.map((item) => item.id === `${requestId}-assistant`
          ? { ...item, text: error instanceof Error ? error.message : "需求暂时没有发送成功，请稍后再试。" }
          : item));
      } finally {
        setSending(false);
      }
    },
    [copy.buyerSuccess, copy.buyerPending, copy.sellerPending, copy.sellerSuccess, isSeller, onNotice, onRecommendations, sending, subplatform.domainId, subplatform.slug, subplatform.tenantId, subplatform.path],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = subplatform.domainId
        ? await getMarketplaceSession({
            subplatform: subplatform.slug,
            platformPath: subplatform.path,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role,
          })
        : null;
      const authState = subplatform.domainId
        ? null
        : await authClient.getSession({ fetchOptions: authFetchOptions(subplatform.slug) });
      if (cancelled) return;
      if (subplatform.domainId && !session) {
        setSignedIn(false);
        return;
      }
      setSignedIn(Boolean(session || authState?.data));
      const pending = readPendingChat();
      if (!pending) return;
      window.sessionStorage.removeItem(PENDING_CHAT_KEY);
      if (!cancelled) void submitMessage(pending.text, session ?? undefined);
    })().catch(() => {
      if (!cancelled) setSignedIn(false);
    });
    return () => { cancelled = true; };
  }, [role, subplatform.domainId, subplatform.slug, subplatform.tenantId, submitMessage]);

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || sending) return;

    void (async () => {
      const session = subplatform.domainId
        ? await getMarketplaceSession({
            subplatform: subplatform.slug,
            platformPath: subplatform.path,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role,
          })
        : null;
      const authState = subplatform.domainId
        ? null
        : await authClient.getSession({ fetchOptions: authFetchOptions(subplatform.slug) });
      if (!session && !authState?.data) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.sessionStorage.setItem(PENDING_CHAT_KEY, JSON.stringify({ text, next } satisfies PendingChat));
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      setSignedIn(true);
      void submitMessage(text, session ?? undefined);
    })().catch((error) => onNotice(error instanceof Error ? error.message : "Better Auth 会话校验失败"));
  };

  return (
    <section className={`match-chat${isRoot ? " is-root" : ""}${isSeller ? " is-seller" : ""}`} aria-labelledby="match-chat-title">
      <div className="match-chat-heading">
        <div>
            <span className="eyebrow"><Sparkles size={14} aria-hidden="true" /> {isSeller ? copy.sellerEyebrow : isRoot ? label("rootEyebrow", "根平台入口") : copy.buyerEyebrow}</span>
          <h1 id="match-chat-title">{isSeller ? copy.sellerTitle : copy.buyerTitle}</h1>
          <p>{isSeller ? copy.sellerDescription : copy.buyerDescription}</p>
        </div>
        <span className={`match-chat-status${signedIn ? " is-signed-in" : ""}`}>
          <LockKeyhole size={14} aria-hidden="true" />
          {signedIn ? label("signedInChatStatus", "已登录 · 直接发送") : label("signedOutChatStatus", "登录后自动继续")}
        </span>
      </div>

      {messages.length ? (
        <div className="match-chat-thread" aria-live="polite">
          {messages.map((item) => (
            <p key={item.id} className={`match-chat-message is-${item.role}`}>{item.text}</p>
          ))}
        </div>
      ) : null}

      <form className="match-chat-form" onSubmit={send}>
        <label className="sr-only" htmlFor="match-chat-input">{isSeller ? `${label("tellPlatformPrefix", "告诉 MatchPlane")} ${copy.sellerTitle}` : label("chatInputLabel", "告诉 MatchPlane 你的需求")}</label>
        <textarea
          id="match-chat-input"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={isSeller ? copy.sellerPlaceholder : copy.buyerPlaceholder}
          rows={2}
          maxLength={10000}
          disabled={sending}
        />
        <button className="match-chat-send" type="submit" aria-label={isSeller ? label("sendSupplyLabel", "发送供给") : label("sendDemandLabel", "发送需求")} disabled={!message.trim() || sending}>
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </form>
      <p className="match-chat-footnote">{isSeller ? copy.sellerFootnote : copy.buyerFootnote}</p>
    </section>
  );
}

function platformPath(subplatform: SubplatformConfig): string {
  return subplatform.path || (subplatform.slug === "root" ? "/" : `/${subplatform.slug}`);
}

function readPendingChat(): PendingChat | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingChat;
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}
