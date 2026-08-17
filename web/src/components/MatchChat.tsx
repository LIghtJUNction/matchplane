"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Trash2 } from "lucide-react";

import {
  createMarketplaceIntent,
  createBuyerRequest,
  getMarketplaceOfferMatches,
  getBuyerRecommendations,
  isLiveMarketplaceEnabled,
  querySubplatformRetrieval,
  type RecommendedBackendListing,
  routePlatformIntent,
  type PlatformRouteHop,
  type PartySession,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { authClient, authFetchOptions } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";
import { loadSubplatform, pricingFor, subplatformCopy, subplatformFieldLabel, type SubplatformConfig } from "../subplatform";

const PENDING_CHAT_KEY = "matchplane.pending-chat";
// A route plan is a bounded protocol result, not an instruction to make dozens of sequential
// marketplace calls from one browser interaction. Keep the UI responsive and leave room for
// partial results when one child service is unavailable.
const MAX_CHAT_TARGETS = 4;
const CHAT_TARGET_CONCURRENCY = 3;

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
  buyerHeadlines: string[];
  sellerHeadlines: string[];
  buyerDescription: string;
  sellerDescription: string;
  buyerPlaceholder: string;
  buyerDiscoveryLabel: string;
  buyerDiscoveryDefault: boolean;
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
  buyerHeadlines: ["先说说你想解决什么。", "让目标找到合适的答案。", "从一句话开始。"],
  sellerHeadlines: ["说说你能提供什么。", "让真实供给被看见。", "把你的优势交给匹配。"],
  buyerDescription: "说出目标、预算和不能妥协的条件。",
  sellerDescription: "说出你能提供的内容、条件和限制。",
  buyerPlaceholder: "例如：我想解决一个具体问题，预算、时间和不能妥协的条件是……",
  buyerDiscoveryLabel: "允许供给方看到这条需求摘要（不含联系方式）",
  buyerDiscoveryDefault: false,
  sellerPlaceholder: "例如：我能提供什么，交付条件和限制是……",
  buyerFootnote: "Enter 发送 · Shift + Enter 换行",
  sellerFootnote: "Enter 发送 · Shift + Enter 换行",
  buyerPending: "我先把你的目标、限制和优先级整理成一份匹配需求。",
  sellerPending: "我先把你的供给、条件和限制整理成一份资料。",
  buyerSuccess: "需求已发送，撮合会围绕你的真实目标展开",
  sellerSuccess: "供给描述已整理；请在下方提交资料，提交后才会写入系统",
};

const defaultChatCopyEn: ChatCopy = {
  buyerEyebrow: "Buyer entry",
  sellerEyebrow: "Seller entry",
  buyerTitle: "Tell us what you want to solve.",
  sellerTitle: "Tell us what you can offer.",
  buyerHeadlines: ["Tell us what you want to solve.", "Find an answer that fits.", "Start with one sentence."],
  sellerHeadlines: ["Tell us what you can offer.", "Let the right people find you.", "Start with one sentence."],
  buyerDescription: "Share your goal, budget, and non-negotiable constraints.",
  sellerDescription: "Share what you offer, the terms, and any constraints.",
  buyerPlaceholder: "For example: I need to solve a specific problem, with this budget, timing, and constraints…",
  buyerDiscoveryLabel: "Let supply agents see this request summary (no contact details)",
  buyerDiscoveryDefault: false,
  sellerPlaceholder: "For example: I can offer this, under these terms and constraints…",
  buyerFootnote: "Enter to send · Shift + Enter for a new line",
  sellerFootnote: "Enter to send · Shift + Enter for a new line",
  buyerPending: "I’m organizing your goal, constraints, and priorities into a matching request.",
  sellerPending: "I’m organizing your offer, terms, and constraints into a listing.",
  buyerSuccess: "Your request was sent; matching will follow your actual goal.",
  sellerSuccess: "Your offer is organized; submit the details below to publish it.",
};

const englishChatLabels: Record<string, string> = {
  clearChatLabel: "Clear",
  sendingChatStatus: "Sending…",
  signedInChatStatus: "Signed in",
  chatThreadLabel: "Conversation",
  tellPlatformPrefix: "Tell MatchPlane",
  chatInputLabel: "Tell MatchPlane what you need",
  sendSupplyLabel: "Send offer",
  sendDemandLabel: "Send request",
};

function resolveChatCopy(subplatform: SubplatformConfig, locale: InterfaceLocale): ChatCopy {
  const configured = subplatform.ui?.chat ?? {};
  const defaults = locale === "en" ? defaultChatCopyEn : defaultChatCopy;
  const text = (key: keyof ChatCopy, fallback: string): string => {
    const value = configured[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  const headlines = (key: "buyerHeadlines" | "sellerHeadlines", fallback: string[]): string[] => {
    const value = configured[key];
    if (!Array.isArray(value)) return fallback;
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 12);
    return items.length ? items : fallback;
  };
  const configuredBuyerHeadlines = headlines("buyerHeadlines", []);
  const configuredSellerHeadlines = headlines("sellerHeadlines", []);
  const buyerTitle = text("buyerTitle", configuredBuyerHeadlines[0] ?? defaults.buyerTitle);
  const sellerTitle = text("sellerTitle", configuredSellerHeadlines[0] ?? defaults.sellerTitle);
  const buyerDiscoveryDefault = typeof configured.demandDiscoveryDefault === "boolean"
    ? configured.demandDiscoveryDefault
    : defaults.buyerDiscoveryDefault;
  return {
    ...defaults,
    buyerEyebrow: text("buyerEyebrow", defaults.buyerEyebrow),
    sellerEyebrow: text("sellerEyebrow", defaults.sellerEyebrow),
    buyerTitle,
    sellerTitle,
    buyerHeadlines: configuredBuyerHeadlines.length ? configuredBuyerHeadlines : [buyerTitle],
    sellerHeadlines: configuredSellerHeadlines.length ? configuredSellerHeadlines : [sellerTitle],
    buyerDescription: text("buyerDescription", defaults.buyerDescription),
    sellerDescription: text("sellerDescription", defaults.sellerDescription),
    buyerPlaceholder: text("buyerPlaceholder", defaults.buyerPlaceholder),
    buyerDiscoveryLabel: text("buyerDiscoveryLabel", defaults.buyerDiscoveryLabel),
    buyerDiscoveryDefault,
    sellerPlaceholder: text("sellerPlaceholder", defaults.sellerPlaceholder),
    buyerFootnote: text("buyerFootnote", defaults.buyerFootnote),
    sellerFootnote: text("sellerFootnote", defaults.sellerFootnote),
    buyerPending: text("buyerPending", defaults.buyerPending),
    sellerPending: text("sellerPending", defaults.sellerPending),
    buyerSuccess: text("buyerSuccess", defaults.buyerSuccess),
    sellerSuccess: text("sellerSuccess", defaults.sellerSuccess),
  };
}

interface MatchChatProps {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
  locale?: InterfaceLocale;
  role?: "buyer" | "seller";
  onRecommendations?: (recommendations: RecommendedBackendListing[]) => void;
  /** Move a seller into the selected terminal platform before showing its supply form. */
  onSellerPlatformSelected?: (hop: PlatformRouteHop) => void | Promise<void>;
}

export function MatchChat({ onNotice, subplatform, locale = "zh", role = "buyer", onRecommendations, onSellerPlatformSelected }: MatchChatProps) {
  const copy = resolveChatCopy(subplatform, locale);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [supplyDiscoveryEnabled, setSupplyDiscoveryEnabled] = useState(copy.buyerDiscoveryDefault);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string | null>(null);
  const focusInputAfterErrorRef = useRef(false);
  const [sellerRouteChoices, setSellerRouteChoices] = useState<PlatformRouteHop[]>([]);
  const isRoot = subplatform.slug === "root";
  const isSeller = role === "seller";
  const label = (key: string, fallback: string) => subplatformCopy(subplatform, key, locale === "en" ? (englishChatLabels[key] ?? fallback) : fallback);
  // Keep the primary action visually stable. A changing/typewriter headline delays
  // scanning and makes a marketplace feel like a demo; merchants may still
  // customize the static copy through the manifest.
  const headline = isSeller ? copy.sellerTitle : copy.buyerTitle;

  const resizeInput = useCallback((input: HTMLTextAreaElement | null) => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }, []);

  useEffect(() => {
    resizeInput(inputRef.current);
  }, [message, resizeInput]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (typeof thread.scrollTo === "function") {
      thread.scrollTo({ top: thread.scrollHeight, behavior });
    } else {
      // jsdom does not implement Element#scrollTo; keeping the fallback makes
      // the log behavior testable without changing the browser experience.
      thread.scrollTop = thread.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (sending || !focusInputAfterErrorRef.current) return;
    focusInputAfterErrorRef.current = false;
    inputRef.current?.focus();
    resizeInput(inputRef.current);
  }, [resizeInput, sending]);

  useEffect(() => {
    // A platform path and a buyer/seller side define the matching scope. Do not carry a
    // conversation identifier or transcript into another node or role by accident.
    setMessages([]);
    setSellerRouteChoices([]);
    setSupplyDiscoveryEnabled(copy.buyerDiscoveryDefault);
    conversationIdRef.current = null;
  }, [copy.buyerDiscoveryDefault, role, subplatform.path]);

  const chooseSellerRoute = useCallback(async (target: PlatformRouteHop) => {
    if (!onSellerPlatformSelected || sending) return;
    setSending(true);
    try {
      await onSellerPlatformSelected(target);
      setSellerRouteChoices([]);
      setMessages((current) => [
        ...current,
        { id: `route-${crypto.randomUUID()}`, role: "assistant", text: `已定位到${target.displayName}，现在可以提交你的供给资料。` },
      ]);
      onNotice(`已切换到${target.displayName}，请继续填写供给资料`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "目标平台暂时无法打开，请稍后重试");
    } finally {
      setSending(false);
    }
  }, [onNotice, onSellerPlatformSelected, sending]);

  const submitMessage = useCallback(
    async (rawText: string, session?: PartySession) => {
      const text = rawText.trim();
      if (!text || sending) return;

      setSending(true);
      setMessage("");
      const requestId = crypto.randomUUID();
      const conversationId = conversationIdRef.current ?? (conversationIdRef.current = crypto.randomUUID());
      const narrative = buildConversationNarrative(
        messages.filter((item) => item.role === "user").map((item) => item.text),
        text,
      );
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
          setMessage(text);
          onNotice(message);
          return;
        }
        const route = live
          ? await routePlatformIntent({
              platformPath: platformPath(subplatform),
              narrative,
              idempotencyKey: requestId,
            })
          : null;
        if (isSeller && route?.routePlan.length) {
          // A seller must publish into the node selected by the platform Agent. The old flow
          // wrote supply intents into every hop and left the form mounted at the root path,
          // which made a successful route look like a dead end. Pick the deepest terminal hop
          // and let App load its package-owned schema before the form is rendered.
          const terminals = terminalRouteHops(route.routePlan).slice(0, MAX_CHAT_TARGETS);
          if (terminals.length > 1) {
            setSellerRouteChoices(terminals);
            setMessages((current) => current.map((item) => item.id === `${requestId}-assistant`
              ? { ...item, text: "我找到了多个适合发布供给的平台，请先选择一个。" }
              : item));
            onNotice("请选择供给发布的平台");
            return;
          }
          const target = terminals[0] ?? route.routePlan.at(-1) ?? null;
          if (target && onSellerPlatformSelected) {
            await onSellerPlatformSelected(target);
          }
          const selectedName = target?.displayName || route.routePlan.at(-1)?.displayName || "目标子平台";
          setMessages((current) => current.map((item) => item.id === `${requestId}-assistant`
            ? { ...item, text: `已定位到${selectedName}，现在可以提交你的供给资料。` }
            : item));
          onNotice(`已切换到${selectedName}，请继续填写供给资料`);
          return;
        }
        const routedRecommendations: RecommendedBackendListing[] = [];
        let retrievalDegraded = false;
        if (live) {
          // The root and every child use the same generic marketplace transport. A route plan is
          // an allow-listed set of target nodes chosen by the platform Agent; send the request
          // to each selected node instead of recording it only at the page the user happened to
          // open. Each target receives its own Better Auth-derived capability and domain scope.
          const allTargets = route?.routePlan.length ? route.routePlan : [null];
          const targets = allTargets.slice(0, MAX_CHAT_TARGETS);
          if (allTargets.length > targets.length) retrievalDegraded = true;
          const processTarget = async (hop: PlatformRouteHop | null) => {
            try {
            const target = hop
              ? {
                  ...(await loadSubplatform(hop.path)),
                  slug: hop.slug,
                  path: hop.path,
                  tenantId: hop.tenantId,
                  domainId: hop.domainId,
                }
              : subplatform;
            if (!target.domainId) return;
            const targetDomainId = target.domainId;
            const targetSession = hop
              ? await getMarketplaceSession({
                  subplatform: target.slug,
                  platformPath: target.path,
                  tenantId: target.tenantId,
                  domainId: targetDomainId,
                  role,
                })
              : session ?? await getMarketplaceSession({
                  subplatform: target.slug,
                  platformPath: target.path,
                  tenantId: target.tenantId,
                  domainId: targetDomainId,
                  role,
                });
            if (!targetSession) throw new Error("Better Auth 会话尚未连接到当前平台节点");
            const targetPricing = pricingFor(target);
            const targetUsesLegacy = target.marketplaceContract === "legacy-v1";
            const targetKey = target.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 96) || "root";
            if (isSeller) {
              await createMarketplaceIntent({
                session: targetSession,
                domainId: targetDomainId,
                side: "supply",
                narrative,
                attributes: {
                  source: "conversation",
                  conversation_id: conversationId,
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
                narrative,
                requirements: {
                  source: "conversation",
                  conversation_id: conversationId,
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
                narrative,
                attributes: {
                  source: "conversation",
                  conversation_id: conversationId,
                },
                terms: {
                  pricing_mode: targetPricing.mode,
                  ...(targetPricing.currency ? { currency: targetPricing.currency } : {}),
                  ...(targetPricing.currencyScale !== undefined ? { currency_scale: targetPricing.currencyScale } : {}),
                },
                supplyDiscoveryEnabled,
                idempotencyKey: `chat-${requestId}-${targetKey}`,
              });
              let retrievalCandidates: RecommendedBackendListing[] = [];
              let canonicalCandidates: Awaited<ReturnType<typeof getMarketplaceOfferMatches>> | null = null;
              if (target.agentMcpTools?.includes("retrieval.query")) {
                try {
                  const retrieval = await querySubplatformRetrieval({
                    requestId,
                    platformPath: target.path,
                    tenantId: target.tenantId ?? targetSession.tenantId,
                    domainId: targetDomainId,
                    narrative,
                    limit: 20,
                    traceId: requestId,
                  });
                  // The child result is only a ranking hint. Re-read the canonical active offers
                  // from the root gateway before displaying anything, so a remote adapter cannot
                  // replace title, attributes, terms, tenant, or offer ownership in the UI.
                  canonicalCandidates = await getMarketplaceOfferMatches({
                    session: targetSession,
                    domainId: targetDomainId,
                    intentId: intent.intent_id,
                  });
                  const remoteByOffer = new Map(
                    retrieval.candidates
                      .filter((candidate) => candidate.offerId)
                      .map((candidate) => [candidate.offerId!, candidate]),
                  );
                  retrievalCandidates = canonicalCandidates.flatMap((candidate) => {
                    const remote = remoteByOffer.get(candidate.offer_id);
                    if (!remote) return [];
                    const reasons = [...new Set([...candidate.reasons, ...remote.reasons])].slice(0, 32);
                    return [{
                      ...candidate,
                      field_labels: fieldLabelsFor(target, candidate.attributes),
                      tenant_id: target.tenantId ?? targetSession.tenantId,
                      domain_id: targetDomainId,
                      platform_path: target.path,
                      subplatform: target.slug,
                      match_score: candidate.score,
                      match_reasons: reasons,
                      intent_id: intent.intent_id,
                    } satisfies RecommendedBackendListing];
                  });
                } catch {
                  // An unavailable child index is a bounded degradation. The kernel matcher
                  // remains useful for exact structured attributes and never receives a fake
                  // neutral score for an empty request.
                  retrievalDegraded = true;
                }
              }
              if (retrievalCandidates.length) {
                routedRecommendations.push(...retrievalCandidates);
              } else {
                const candidates = canonicalCandidates ?? await getMarketplaceOfferMatches({
                  session: targetSession,
                  domainId: targetDomainId,
                  intentId: intent.intent_id,
                });
                routedRecommendations.push(...candidates.map((candidate) => ({
                  ...candidate,
                  field_labels: fieldLabelsFor(target, candidate.attributes),
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
            } catch (error) {
              // One child being offline must not erase matches already returned by other active
              // nodes. Keep the partial result and make the degraded state visible below.
              retrievalDegraded = true;
              console.error("platform child marketplace request failed", error);
            }
          };
          await runWithConcurrency(targets, CHAT_TARGET_CONCURRENCY, processTarget);
          // A successful request with no candidates is still a new result. Clear
          // the previous cards instead of leaving stale offers on screen and
          // making them look like matches for the latest message.
          onRecommendations?.(routedRecommendations);
        }
        const visibleRouteNames = route?.routePlan
          .slice(0, MAX_CHAT_TARGETS)
          .map((hop) => hop.displayName)
          .join("、") || "当前平台节点";
        const routeOverflowSuffix = route && route.routePlan.length > MAX_CHAT_TARGETS ? " 等平台" : "";
        const assistantText = isSeller
          ? copy.sellerSuccess
          : live
            ? route?.status === "degraded" && route.routePlan.length
              ? `AI 路由暂时不可用，已按受控策略把需求交给 ${visibleRouteNames}${routeOverflowSuffix}；下级平台会继续筛选商家与具体供给。`
              : route?.routePlan.length
                ? `AI 已从当前节点的候选平台中选出 ${visibleRouteNames}${routeOverflowSuffix}，接下来由下级平台继续挑选商家与具体供给，并解释匹配理由。`
                : route?.routing.source === "ai"
                  ? "需求已记录在当前平台节点；AI 判断当前候选平台暂时没有合适的匹配。你可以补充目标、预算或限制条件后重试。"
                  : "需求已记录在当前平台节点，当前没有已激活的下级平台；管理员启用子平台后会继续向下传递。"
            : "需求已记录在当前平台节点。";
        const degradedSuffix = retrievalDegraded
          ? " 子平台智能检索暂时不可用，已先使用基础条件匹配；管理员配置检索服务后会自动恢复。"
          : "";
        setMessages((current) => current.map((item) => item.id === `${requestId}-assistant`
          ? { ...item, text: `${assistantText}${isSeller ? "" : degradedSuffix}` }
          : item));
        onNotice(retrievalDegraded
          ? "子平台智能检索暂时不可用，已先使用基础条件匹配"
          : isSeller ? copy.sellerSuccess : copy.buyerSuccess);
        if (isSeller) window.setTimeout(() => document.getElementById("seller-display-name")?.focus(), 0);
      } catch (error) {
        setMessages((current) => current.map((item) => item.id === `${requestId}-assistant`
          ? { ...item, text: error instanceof Error ? error.message : "需求暂时没有发送成功，请稍后再试。" }
          : item));
        setMessage(text);
        focusInputAfterErrorRef.current = true;
      } finally {
        setSending(false);
      }
    },
    [copy.buyerSuccess, copy.buyerPending, copy.sellerPending, copy.sellerSuccess, isSeller, messages, onNotice, onRecommendations, onSellerPlatformSelected, resizeInput, role, sending, supplyDiscoveryEnabled, subplatform.domainId, subplatform.slug, subplatform.tenantId, subplatform.path],
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
      const hasAuthSession = Boolean(session || authState?.data);
      setSignedIn(hasAuthSession);
      const pending = readPendingChat();
      if (!pending) return;
      // A pending message is only a hand-off across the login page. Keep it until the user is
      // authenticated and still on the exact path it came from; otherwise a signed-out refresh
      // could consume it without a valid marketplace capability or send it to the wrong node.
      if (!hasAuthSession || pending.next !== currentLocation()) return;
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
        window.location.assign(`/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`);
        return;
      }
      setSignedIn(true);
      void submitMessage(text, session ?? undefined);
    })().catch((error) => onNotice(error instanceof Error ? error.message : "Better Auth 会话校验失败"));
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const clearConversation = () => {
    if (sending) return;
    setMessages([]);
    conversationIdRef.current = null;
  };

  return (
    <section className={`match-chat${isRoot ? " is-root" : ""}${isSeller ? " is-seller" : ""}`} aria-labelledby="match-chat-title">
      <div className="match-chat-heading">
        <div>
          <h1 id="match-chat-title">{headline}</h1>
          <p>{isSeller ? copy.sellerDescription : copy.buyerDescription}</p>
        </div>
        <div className="match-chat-actions">
          {messages.length ? (
            <button className="match-chat-clear" type="button" onClick={clearConversation} disabled={sending}>
              <Trash2 size={14} aria-hidden="true" />
              <span>{label("clearChatLabel", "清空")}</span>
            </button>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {sending ? label("sendingChatStatus", "正在发送…") : signedIn ? label("signedInChatStatus", "已登录") : ""}
          </span>
        </div>
      </div>

      {messages.length ? (
        <div ref={threadRef} className="match-chat-thread" role="log" aria-live="polite" aria-relevant="additions text" aria-label={label("chatThreadLabel", "对话记录")}>
          {messages.map((item) => (
            <p key={item.id} className={`match-chat-message is-${item.role}`}>{item.text}</p>
          ))}
        </div>
      ) : null}

      {sellerRouteChoices.length ? (
        <div className="match-chat-route-choices" role="group" aria-label="选择供给发布平台">
          {sellerRouteChoices.map((target) => (
            <button
              key={target.path}
              type="button"
              className="match-chat-route-choice"
              disabled={sending}
              onClick={() => void chooseSellerRoute(target)}
            >
              <span>{target.displayName}</span>
              <small>{target.path}</small>
            </button>
          ))}
        </div>
      ) : null}

      <form className="match-chat-form" onSubmit={send}>
        <label className="sr-only" htmlFor="match-chat-input">{isSeller ? `${label("tellPlatformPrefix", "告诉 MatchPlane")} ${copy.sellerTitle}` : label("chatInputLabel", "告诉 MatchPlane 你的需求")}</label>
        <textarea
          ref={inputRef}
          id="match-chat-input"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            resizeInput(event.currentTarget);
          }}
          onKeyDown={handleInputKeyDown}
          placeholder={isSeller ? copy.sellerPlaceholder : copy.buyerPlaceholder}
          rows={2}
          maxLength={10000}
          aria-describedby="match-chat-footnote"
          disabled={sending}
        />
        <button className="match-chat-send" type="submit" aria-label={isSeller ? label("sendSupplyLabel", "发送供给") : label("sendDemandLabel", "发送需求")} aria-busy={sending} disabled={!message.trim() || sending}>
          {sending ? <LoaderCircle className="match-chat-spinner" size={18} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
        </button>
      </form>
      {!isSeller ? (
        <label className="match-chat-discovery">
          <input
            type="checkbox"
            checked={supplyDiscoveryEnabled}
            onChange={(event) => setSupplyDiscoveryEnabled(event.currentTarget.checked)}
            disabled={sending}
          />
          <span>{copy.buyerDiscoveryLabel}</span>
        </label>
      ) : null}
      <p id="match-chat-footnote" className="match-chat-footnote">{isSeller ? copy.sellerFootnote : copy.buyerFootnote}</p>
    </section>
  );
}

function fieldLabelsFor(subplatform: SubplatformConfig, attributes: Record<string, unknown>): Record<string, string> {
  return Object.keys(attributes)
    .slice(0, 32)
    .reduce<Record<string, string>>((labels, key) => {
      labels[key] = subplatformFieldLabel(subplatform, key);
      return labels;
    }, {});
}

/** Keep follow-up requests useful without sending an unbounded transcript to the router/model. */
function buildConversationNarrative(previousRequests: string[], currentRequest: string): string {
  const recent = previousRequests
    .slice(-4)
    .map((value, index) => `第${index + 1}条已知需求：${value.trim().slice(0, 1_200)}`)
    .filter((value) => value.length > 8);
  const combined = recent.length
    ? `这是同一对话的补充请求。${recent.join("\n")}\n本轮最新需求：${currentRequest}`
    : currentRequest;
  return combined.slice(0, 8_000);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await worker(item);
    }
  }));
}

function platformPath(subplatform: SubplatformConfig): string {
  return subplatform.path || (subplatform.slug === "root" ? "/" : `/${subplatform.slug}`);
}

function readPendingChat(): PendingChat | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingChat;
    if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 10000) return null;
    if (typeof parsed.next !== "string" || !isSafePendingLocation(parsed.next)) return null;
    return { text: parsed.text.trim(), next: parsed.next };
  } catch {
    return null;
  }
}

function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function isSafePendingLocation(value: string): boolean {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Return the first deepest route node; intermediate platform nodes are aggregation boundaries. */
function terminalRouteHops(routePlan: PlatformRouteHop[]): PlatformRouteHop[] {
  const terminals = routePlan.filter((candidate) => !routePlan.some((other) => (
    other.path !== candidate.path && other.path.startsWith(`${candidate.path}/`)
  )));
  const unique = new Map(terminals.map((candidate) => [candidate.path, candidate]));
  return [...unique.values()];
}
