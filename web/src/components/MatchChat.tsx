"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowUp, LockKeyhole, Sparkles } from "lucide-react";

import {
  createBuyerRequest,
  isLiveMarketplaceEnabled,
  routePlatformIntent,
  type PartySession,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { authClient, authFetchOptions } from "../lib/auth-client";
import type { SubplatformConfig } from "../subplatform";

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

interface MatchChatProps {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}

export function MatchChat({ onNotice, subplatform }: MatchChatProps) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const isRoot = subplatform.slug === "root";

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
          id: `${requestId}-assistant-pending`,
          role: "assistant",
          text: "我先把你的目标、限制和优先级整理成一份匹配需求。",
        },
      ]);

      try {
        const live = isLiveMarketplaceEnabled();
        const route = live
          ? await routePlatformIntent({ platformPath: platformPath(subplatform), narrative: text })
          : null;
        if (live) {
          if (subplatform.domainId) {
            if (!session) throw new Error("Better Auth 会话尚未连接到当前子平台");
            await createBuyerRequest({
              session,
              domainId: subplatform.domainId,
              narrative: text,
              requirements: {
                source: "conversation",
                intent: "general_match",
                platform_path: platformPath(subplatform),
                delegated_route_count: route?.routePlan.length ?? 0,
                routing_source: route?.routing.source ?? null,
                routing_degraded: route?.routing.degraded ?? false,
              },
              currency: "CNY",
              currencyScale: 2,
            });
          }
        }
        setMessages((current) => [
          ...current,
          {
            id: `${requestId}-assistant-done`,
            role: "assistant",
            text: live
              ? route?.status === "degraded" && route.routePlan.length
                ? `AI 路由暂时不可用，已按受控策略把需求交给 ${route.routePlan.map((hop) => hop.displayName).join("、")}；子平台会继续筛选商家和具体商品。`
                : route?.routePlan.length
                  ? `AI 已从当前节点的候选商城中选出 ${route.routePlan.map((hop) => hop.displayName).join("、")}，接下来由子平台继续挑选商家、货柜和商品，并解释匹配理由。`
                  : route?.routing.source === "ai"
                    ? "需求已记录在当前平台节点；AI 判断当前候选商城暂时没有合适的匹配。你可以补充用途、预算或限制条件后重试。"
                    : "需求已记录在当前平台节点，当前没有已激活的下级商城；管理员启用子平台后会继续向下传递。"
              : "需求已记录（演示模式）。登录状态有效，下一步会按你的条件给出匹配与理由。",
          },
        ]);
        onNotice("需求已发送，撮合会围绕你的真实目标展开");
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            id: `${requestId}-assistant-error`,
            role: "assistant",
            text: error instanceof Error ? error.message : "需求暂时没有发送成功，请稍后再试。",
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [onNotice, sending, subplatform.domainId, subplatform.slug, subplatform.tenantId, subplatform.path],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = subplatform.domainId
        ? await getMarketplaceSession({
            subplatform: subplatform.slug,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role: "buyer",
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
  }, [subplatform.domainId, subplatform.slug, subplatform.tenantId, submitMessage]);

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || sending) return;

    void (async () => {
      const session = subplatform.domainId
        ? await getMarketplaceSession({
            subplatform: subplatform.slug,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role: "buyer",
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
    <section className="match-chat" aria-labelledby="match-chat-title">
      <div className="match-chat-heading">
        <div>
          <span className="eyebrow"><Sparkles size={14} aria-hidden="true" /> {isRoot ? "根平台 AI 撮合入口" : `${subplatform.label || "当前平台"} AI 撮合入口`}</span>
          <h1 id="match-chat-title">先说说你想解决什么。</h1>
          <p>{isRoot
            ? "不用先选分类。根平台会理解你的目标，再把需求沿平台层级传递给已启用的子平台。"
            : `不用先选分类。告诉我目标、预算、时间和不能妥协的条件，${subplatform.label || "当前平台"} 会先处理，再继续询问下属平台。`}</p>
        </div>
        <span className={`match-chat-status${signedIn ? " is-signed-in" : ""}`}>
          <LockKeyhole size={14} aria-hidden="true" />
          {signedIn ? "已登录 · 直接发送" : "登录后自动继续"}
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
        <label className="sr-only" htmlFor="match-chat-input">告诉 MatchPlane 你的需求</label>
        <textarea
          id="match-chat-input"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="例如：我想解决一个具体问题，预算、时间和不能妥协的条件是……"
          rows={2}
          maxLength={10000}
          disabled={sending}
        />
        <button className="match-chat-send" type="submit" aria-label="发送需求" disabled={!message.trim() || sending}>
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </form>
      <p className="match-chat-footnote">联系方式只在双方同意后交换；线下成交也会保留平台撮合记录。</p>
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
