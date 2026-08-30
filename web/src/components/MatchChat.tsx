"use client";

import {
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Brain,
  Compass,
  FileUp,
  History,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@appica/ui-react/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu";
import { Textarea } from "@appica/ui-react/textarea";

import {
  createMarketplaceIntent,
  askMallShoppingAssistant,
  createBuyerRequest,
  getMarketplaceOfferMatches,
  getBuyerRecommendations,
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  MarketplaceApiError,
  uploadMarketplaceAttachment,
  querySubplatformRetrieval,
  updateMarketplaceIntent,
  upsertMarketplaceProfile,
  type MallAssistantChoiceAction,
  type MallAssistantContactConsentAction,
  type MallAssistantHumanHandoffAction,
  type MallAssistantSearchTrace,
  type MarketplaceContactResponse,
  type RecommendedBackendListing,
  routePlatformIntent,
  type PlatformRouteHop,
  type PartySession,
  type MarketplaceAttachment,
  updateMarketplaceDemandDiscovery,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { authClient, authFetchOptions } from "../lib/auth-client";
import {
  clearChatDraft,
  readChatDraft,
  writeChatDraft,
  type ChatDraftScope,
} from "../lib/chat-draft-session";
import {
  conversationHistoryStorageKey,
  deleteConversationHistory,
  readConversationHistory,
  upsertConversationHistory,
  type ConversationHistoryRecord,
} from "../lib/conversation-history";
import type { InterfaceLocale } from "../lib/preferences";
import { mapRecommendations } from "../marketplace-listings";
import {
  buildCanonicalRecommendations,
  buildProviderSelectedRecommendations,
} from "../recommendation-provenance";
import {
  clearPendingConversion,
  readPendingConversion,
} from "../pending-conversion";
import type { AssetListing } from "../types";
import { AssistantThinkingStatus } from "./AssistantThinkingStatus";
import { MatchChatMetalHalo } from "./MatchChatMetalHalo";
import { ConversationHistoryPanel } from "./ConversationHistoryPanel";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
import { ShoppingMemoryPanel } from "./ShoppingMemoryPanel";
import { StoreContactConsentCard } from "./StoreContactConsentCard";
import {
  loadSubplatform,
  pricingFor,
  subplatformCopy,
  subplatformFieldLabel,
  type SubplatformConfig,
} from "../subplatform";

const PENDING_CHAT_KEY = "matchplane.pending-chat";
// A route plan is a bounded protocol result, not an instruction to make dozens of sequential
// marketplace calls from one browser interaction. Keep the UI responsive and leave room for
// partial results when one child service is unavailable.
const MAX_CHAT_TARGETS = 4;
const CHAT_TARGET_CONCURRENCY = 3;
const HOME_PLACEHOLDER_EXAMPLES = {
  zh: ["描述想买的东西和预算"],
  en: ["Describe what you want and your budget"],
} as const;

function homePlaceholderFor(
  locale: InterfaceLocale,
  _enabled: boolean,
  configuredPhrases?: string[],
) {
  if (configuredPhrases?.length) {
    return configuredPhrases[0];
  }
  return HOME_PLACEHOLDER_EXAMPLES[locale][0];
}

interface RecoverableChatError {
  detail: string;
  failedUserMessageId: string;
  prompt: string;
  retryAfterMs?: number;
}

function formatRetryTiming(
  retryAfterMs: number | undefined,
  locale: InterfaceLocale,
): string | null {
  if (!retryAfterMs || retryAfterMs <= 0) return null;
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  if (seconds < 60) {
    return locale === "en"
      ? `Try again in about ${seconds} seconds.`
      : `建议约 ${seconds} 秒后重试。`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return locale === "en"
      ? `Try again in about ${minutes} minutes.`
      : `建议约 ${minutes} 分钟后重试。`;
  }
  const hours = Math.ceil(minutes / 60);
  return locale === "en"
    ? `Try again in about ${hours} hours.`
    : `建议约 ${hours} 小时后重试。`;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: MarketplaceAttachment[];
  choices?: Array<MallAssistantChoiceAction & { selectedValue?: string }>;
  recommendations?: AssetListing[];
  handoff?: Pick<
    MallAssistantHumanHandoffAction,
    "type" | "intent" | "productIds"
  > & {
    requestId: string;
    conversionAttemptId: string;
    status:
      | "confirmation_required"
      | "sending"
      | "sent"
      | "failed"
      | "cancelled";
  };
  contactConsent?: MallAssistantContactConsentAction;
}

type ChatHandoffStatus = NonNullable<ChatMessage["handoff"]>["status"];

function localeText(locale: InterfaceLocale, en: string, zh: string): string {
  return locale === "en" ? en : zh;
}

function assistantRoleLabel(
  platformSlug: string,
  locale: InterfaceLocale,
): string {
  if (platformSlug === "root") {
    return localeText(locale, "Shopping Assistant", "选货员");
  }
  return localeText(locale, "AI Store Manager", "AI 店长");
}

function handoffStatusLabel(
  status: ChatHandoffStatus,
  locale: InterfaceLocale,
): string {
  switch (status) {
    case "confirmation_required":
      return localeText(locale, "Notify store staff?", "要通知店员吗？");
    case "sending":
      return localeText(
        locale,
        "Saving your handoff request…",
        "正在记录人工介入请求…",
      );
    case "sent":
      return localeText(locale, "Handoff request saved", "人工介入请求已记录");
    case "cancelled":
      return localeText(locale, "Store staff were not notified", "未通知店员");
    case "failed":
      return localeText(locale, "Handoff request failed", "人工介入请求失败");
  }
}

function handoffActionLabel(
  status: ChatHandoffStatus,
  locale: InterfaceLocale,
): string {
  if (status === "failed") {
    return localeText(locale, "Try again", "重试");
  }
  return localeText(locale, "Confirm and notify", "确认并通知");
}

function parseStoredChoices(value: unknown): ChatMessage["choices"] {
  if (!Array.isArray(value)) return undefined;
  const choices = value.slice(0, 2).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as {
      id?: unknown;
      type?: unknown;
      question?: unknown;
      options?: unknown;
      selectedValue?: unknown;
    };
    if (
      candidate.type !== "choice" ||
      typeof candidate.id !== "string" ||
      typeof candidate.question !== "string" ||
      !candidate.question.trim() ||
      !Array.isArray(candidate.options)
    )
      return [];
    const options = candidate.options.slice(0, 6).flatMap((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option))
        return [];
      const entry = option as {
        id?: unknown;
        label?: unknown;
        value?: unknown;
      };
      return typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        entry.label.trim() &&
        typeof entry.value === "string" &&
        entry.value.trim()
        ? [{ id: entry.id, label: entry.label, value: entry.value }]
        : [];
    });
    if (options.length < 2) return [];
    return [
      {
        type: "choice" as const,
        id: candidate.id,
        question: candidate.question,
        options,
        ...(typeof candidate.selectedValue === "string" &&
        options.some((option) => option.value === candidate.selectedValue)
          ? { selectedValue: candidate.selectedValue }
          : {}),
      },
    ];
  });
  return choices.length ? choices : undefined;
}

const SHOPPING_CONVERSATION_KEY = "matchplane.shopping-conversation.v1";
const MAX_CONVERSATION_MESSAGES = 24;

function parseStoredRecommendations(value: unknown): AssetListing[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.title !== "string" ||
      !candidate.title.trim() ||
      typeof candidate.price !== "string"
    )
      return [];
    const text = (key: string) =>
      typeof candidate[key] === "string" && candidate[key].trim()
        ? candidate[key].trim()
        : undefined;
    const imageUrls = Array.isArray(candidate.imageUrls)
      ? candidate.imageUrls
          .filter(
            (url): url is string =>
              typeof url === "string" && Boolean(url.trim()),
          )
          .map((url) => url.trim())
          .slice(0, 12)
      : [];
    const accent = ["cactus", "clay", "heather", "oat"].includes(
      String(candidate.accent),
    )
      ? (candidate.accent as AssetListing["accent"])
      : "cactus";
    return [
      {
        id: candidate.id,
        title: candidate.title.trim(),
        subtitle: text("subtitle") ?? "",
        price: candidate.price,
        accent,
        facts: [],
        ...(text("description") ? { description: text("description") } : {}),
        ...(text("imageUrl") ? { imageUrl: text("imageUrl") } : {}),
        ...(imageUrls.length ? { imageUrls } : {}),
        ...(text("storeId") ? { storeId: text("storeId") } : {}),
        ...(text("storeName") ? { storeName: text("storeName") } : {}),
        ...(text("platformPath") ? { platformPath: text("platformPath") } : {}),
        ...(text("subplatform") ? { subplatform: text("subplatform") } : {}),
        ...(text("tenantId") ? { tenantId: text("tenantId") } : {}),
        ...(text("domainId") ? { domainId: text("domainId") } : {}),
        ...(text("offerId") ? { offerId: text("offerId") } : {}),
        ...(text("intentId") ? { intentId: text("intentId") } : {}),
        ...(text("seller") ? { seller: text("seller") } : {}),
        ...(typeof candidate.likeTotal === "string"
          ? { likeTotal: candidate.likeTotal }
          : {}),
        ...(typeof candidate.viewerLikeCount === "number"
          ? { viewerLikeCount: candidate.viewerLikeCount }
          : {}),
        ...(typeof candidate.matchScore === "number"
          ? { matchScore: candidate.matchScore }
          : {}),
      },
    ];
  });
}

function parseStoredMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_CONVERSATION_MESSAGES).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    const id = (item as { id?: unknown }).id;
    const choices = parseStoredChoices((item as { choices?: unknown }).choices);
    const recommendations = parseStoredRecommendations(
      (item as { recommendations?: unknown }).recommendations,
    );
    if (
      (role !== "user" && role !== "assistant") ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 2_000
    )
      return [];
    return [
      {
        id: typeof id === "string" && id ? id : crypto.randomUUID(),
        role,
        text,
        ...(choices ? { choices } : {}),
        ...(recommendations.length ? { recommendations } : {}),
      } satisfies ChatMessage,
    ];
  });
}

function readStoredConversation(
  key: string,
  owner: string,
): { id: string; messages: ChatMessage[] } {
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(key) ?? "null",
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { id: crypto.randomUUID(), messages: [] };
    const storedOwner = (value as { owner?: unknown }).owner;
    if (storedOwner !== owner) return { id: crypto.randomUUID(), messages: [] };
    const id = (value as { id?: unknown }).id;
    return {
      id: typeof id === "string" && id ? id : crypto.randomUUID(),
      messages: parseStoredMessages((value as { messages?: unknown }).messages),
    };
  } catch {
    return { id: crypto.randomUUID(), messages: [] };
  }
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
  buyerSuccess: string;
  sellerSuccess: string;
}

const defaultChatCopy: ChatCopy = {
  buyerEyebrow: "商品筛选",
  sellerEyebrow: "供给方入口",
  buyerTitle: "说说预算和需求",
  sellerTitle: "说说你能提供什么。",
  buyerHeadlines: [
    "说说预算和需求",
    "帮你逛店、比价、算清总价",
    "从在售商品里开始挑",
  ],
  sellerHeadlines: [
    "说说你能提供什么。",
    "让真实供给被看见。",
    "把你的优势交给匹配。",
  ],
  buyerDescription:
    "按你的描述，从各店铺在售商品里筛选、比价并说明理由。无需登录即可开始。",
  sellerDescription: "说出你能提供的内容、条件和限制。",
  buyerPlaceholder: "输入预算、用途和偏好……",
  buyerDiscoveryLabel: "允许供给方看到这条需求摘要（不含联系方式）",
  buyerDiscoveryDefault: false,
  sellerPlaceholder: "例如：我能提供什么，交付条件和限制是……",
  buyerFootnote: "Enter 发送 · Shift + Enter 换行",
  sellerFootnote: "Enter 发送 · Shift + Enter 换行",
  buyerSuccess: "商品已经按你的需求整理好了",
  sellerSuccess: "供给描述已整理；请在下方提交资料，提交后才会写入系统",
};

const defaultChatCopyEn: ChatCopy = {
  buyerEyebrow: "Product search",
  sellerEyebrow: "Seller entry",
  buyerTitle: "Share your budget and needs",
  sellerTitle: "Tell us what you can offer.",
  buyerHeadlines: [
    "Share your budget and needs",
    "Browse stores and compare prices",
    "Start from what's on sale",
  ],
  sellerHeadlines: [
    "Tell us what you can offer.",
    "Let the right people find you.",
    "Start with one sentence.",
  ],
  buyerDescription:
    "We filter live listings, compare prices, and explain the fit. No sign-in needed to browse.",
  sellerDescription: "Share what you offer, the terms, and any constraints.",
  buyerPlaceholder: "Describe your budget, needs, and preferences…",
  buyerDiscoveryLabel:
    "Let supply agents see this request summary (no contact details)",
  buyerDiscoveryDefault: false,
  sellerPlaceholder:
    "For example: I can offer this, under these terms and constraints…",
  buyerFootnote: "Enter to send · Shift + Enter for a new line",
  sellerFootnote: "Enter to send · Shift + Enter for a new line",
  buyerSuccess: "Products have been organized around what you asked for.",
  sellerSuccess:
    "Your offer is organized; submit the details below to publish it.",
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

interface RuntimeChatCopy {
  sellerLocated: (name: string) => string;
  sellerSwitched: (name: string) => string;
  routeOpenError: string;
  unavailableSupply: string;
  unavailableDemand: string;
  multiplePlatforms: string;
  choosePlatform: string;
  targetPlatform: string;
  authDisconnected: string;
  routeNode: string;
  routeOverflow: string;
  routeDegraded: (names: string, overflow: string) => string;
  routeSelected: (names: string, overflow: string) => string;
  noMatch: string;
  noChildren: string;
  recorded: string;
  retrievalDegraded: string;
  retrievalDegradedNotice: string;
  sendFailed: string;
  authFailed: string;
  routeChoicesAria: string;
}

function runtimeChatCopy(locale: InterfaceLocale): RuntimeChatCopy {
  if (locale === "en") {
    return {
      sellerLocated: (name) =>
        `Located ${name}. You can submit your offer details now.`,
      sellerSwitched: (name) =>
        `Switched to ${name}. Continue with your offer details.`,
      routeOpenError:
        "The target platform could not be opened. Try again shortly.",
      unavailableSupply:
        "This environment is not connected to the live supply API, so nothing was saved. Enable the platform API before sending.",
      unavailableDemand:
        "This environment is not connected to the live matching API, so nothing was saved. Enable the platform API before sending.",
      multiplePlatforms:
        "I found several suitable platforms for this offer. Choose one to continue.",
      choosePlatform: "Choose a platform for this offer.",
      targetPlatform: "target subplatform",
      authDisconnected:
        "The Better Auth session is not connected to this platform node.",
      routeNode: "the current platform node",
      routeOverflow: " and other platforms",
      routeDegraded: (names, overflow) =>
        `Routing is temporarily degraded. Your request was sent to ${names}${overflow} under the bounded fallback; downstream platforms will continue looking for supply.`,
      routeSelected: (names, overflow) =>
        `The routing Agent selected ${names}${overflow}. Downstream platforms will now look for merchants and specific offers, with an explanation for each match.`,
      noMatch:
        "Your request was recorded here, but the routing Agent did not find a suitable active platform. Add a goal, budget, or constraint and try again.",
      noChildren:
        "Your request was recorded here. There are no active child platforms yet; an administrator can enable one to continue routing.",
      recorded: "Your request was recorded on this platform node.",
      retrievalDegraded:
        " A child retrieval service is temporarily unavailable, so basic condition matching is being used. It will recover when the administrator configures the service.",
      retrievalDegradedNotice:
        "Child retrieval is temporarily unavailable; basic condition matching is being used.",
      sendFailed: "Your request could not be sent. Try again shortly.",
      authFailed: "The Better Auth session check did not complete.",
      routeChoicesAria: "Choose a platform for publishing an offer",
    };
  }
  return {
    sellerLocated: (name) => `已定位到${name}，现在可以提交你的供给资料。`,
    sellerSwitched: (name) => `已切换到${name}，请继续填写供给资料`,
    routeOpenError: "目标平台暂时无法打开，请稍后重试",
    unavailableSupply:
      "当前环境未连接真实供给 API，内容没有写入系统。请启用平台 API 后重试。",
    unavailableDemand:
      "当前环境未连接真实撮合 API，内容没有写入系统。请启用平台 API 后重试。",
    multiplePlatforms: "我找到了多个适合发布供给的平台，请先选择一个。",
    choosePlatform: "请选择供给发布的平台",
    targetPlatform: "目标店铺",
    authDisconnected: "登录会话尚未连接到当前店铺",
    routeNode: "商城",
    routeOverflow: " 等平台",
    routeDegraded: (names, overflow) =>
      `搜索服务暂时繁忙，已按相关性在 ${names}${overflow} 中查找商品。`,
    routeSelected: (names, overflow) =>
      `已从 ${names}${overflow} 的在售商品中挑选并说明理由。`,
    noMatch:
      "暂时没有找到合适的店铺。你可以补充品类、预算或必须具备的功能后重试。",
    noChildren: "商城目前还没有上线店铺。",
    recorded: "你的购物需求已经记录。",
    retrievalDegraded: " 部分店铺检索暂时不可用，已先按基础商品条件匹配。",
    retrievalDegradedNotice: "部分店铺检索暂时不可用，已先按基础条件匹配",
    sendFailed: "需求暂时没有发送成功，请稍后再试。",
    authFailed: "Better Auth 会话校验失败",
    routeChoicesAria: "选择供给发布平台",
  };
}

function resolveChatCopy(
  subplatform: SubplatformConfig,
  locale: InterfaceLocale,
): ChatCopy {
  const configured = subplatform.ui?.chat ?? {};
  const defaults = locale === "en" ? defaultChatCopyEn : defaultChatCopy;
  const text = (key: keyof ChatCopy, fallback: string): string => {
    const localizedKey = locale === "en" ? `${key}En` : key;
    const value = configured[localizedKey];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  const headlines = (
    key: "buyerHeadlines" | "sellerHeadlines",
    fallback: string[],
  ): string[] => {
    const localizedKey = locale === "en" ? `${key}En` : key;
    const value = configured[localizedKey];
    if (!Array.isArray(value)) return fallback;
    const items = value
      .filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
      .map((item) => item.trim())
      .slice(0, 12);
    return items.length ? items : fallback;
  };
  const configuredBuyerHeadlines = headlines("buyerHeadlines", []);
  const configuredSellerHeadlines = headlines("sellerHeadlines", []);
  const buyerTitle = text(
    "buyerTitle",
    configuredBuyerHeadlines[0] ?? defaults.buyerTitle,
  );
  const sellerTitle = text(
    "sellerTitle",
    configuredSellerHeadlines[0] ?? defaults.sellerTitle,
  );
  const buyerDiscoveryDefault =
    typeof configured.demandDiscoveryDefault === "boolean"
      ? configured.demandDiscoveryDefault
      : defaults.buyerDiscoveryDefault;
  return {
    ...defaults,
    buyerEyebrow: text("buyerEyebrow", defaults.buyerEyebrow),
    sellerEyebrow: text("sellerEyebrow", defaults.sellerEyebrow),
    buyerTitle,
    sellerTitle,
    buyerHeadlines: configuredBuyerHeadlines.length
      ? configuredBuyerHeadlines
      : [buyerTitle],
    sellerHeadlines: configuredSellerHeadlines.length
      ? configuredSellerHeadlines
      : [sellerTitle],
    buyerDescription: text("buyerDescription", defaults.buyerDescription),
    sellerDescription: text("sellerDescription", defaults.sellerDescription),
    buyerPlaceholder: text("buyerPlaceholder", defaults.buyerPlaceholder),
    buyerDiscoveryLabel: text(
      "buyerDiscoveryLabel",
      defaults.buyerDiscoveryLabel,
    ),
    buyerDiscoveryDefault,
    sellerPlaceholder: text("sellerPlaceholder", defaults.sellerPlaceholder),
    buyerFootnote: text("buyerFootnote", defaults.buyerFootnote),
    sellerFootnote: text("sellerFootnote", defaults.sellerFootnote),
    buyerSuccess: text("buyerSuccess", defaults.buyerSuccess),
    sellerSuccess: text("sellerSuccess", defaults.sellerSuccess),
  };
}

interface MatchChatProps {
  compact?: boolean;
  home?: boolean;
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
  locale?: InterfaceLocale;
  role?: "buyer" | "seller";
  onLikeListing?: (listing: AssetListing) => Promise<void>;
  onOpenListing?: (listing: AssetListing) => void;
  onRecommendations?: (recommendations: RecommendedBackendListing[]) => void;
  onSearchTrace?: (trace: MallAssistantSearchTrace | null) => void;
  onHumanHandoff?: (input: {
    requestId: string;
    conversionAttemptId: string;
    intent: MallAssistantHumanHandoffAction["intent"];
    productIds: string[];
  }) => Promise<void>;
  onContactConsent?: (
    action: MallAssistantContactConsentAction,
  ) => Promise<unknown>;
  onContactRetrieve?: (
    action: MallAssistantContactConsentAction,
  ) => Promise<MarketplaceContactResponse | null>;
  /** Pass the seller's conversational draft into the schema-driven editor. */
  onSellerDraft?: (draft: {
    narrative: string;
    intentId?: string;
    attributes: Record<string, unknown>;
    terms: Record<string, unknown>;
    attachments?: MarketplaceAttachment[];
  }) => void;
  /** Move a seller into the selected terminal platform before showing its supply form. */
  onSellerPlatformSelected?: (hop: PlatformRouteHop) => void | Promise<void>;
  /** Prefill the composer when opened from another entry point on the same page. */
  draftMessage?: string;
  onDraftMessageApplied?: () => void;
}

export function MatchChat({
  compact = false,
  home = false,
  onNotice,
  subplatform,
  locale = "zh",
  role = "buyer",
  onLikeListing,
  onOpenListing,
  onRecommendations,
  onSearchTrace,
  onHumanHandoff,
  onContactConsent,
  onContactRetrieve,
  onSellerDraft,
  onSellerPlatformSelected,
  draftMessage,
  onDraftMessageApplied,
}: MatchChatProps) {
  const copy = resolveChatCopy(subplatform, locale);
  const runtime = runtimeChatCopy(locale);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState("");
  const [conversationHistory, setConversationHistory] = useState<
    ConversationHistoryRecord<ChatMessage>[]
  >([]);
  const [conversationHistoryOpen, setConversationHistoryOpen] = useState(false);
  const [conversationHydrated, setConversationHydrated] = useState(false);
  const [conversationOwner, setConversationOwner] = useState<string | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<RecoverableChatError | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [shoppingMemoryOpen, setShoppingMemoryOpen] = useState(false);
  const [conversationAttachments, setConversationAttachments] = useState<
    MarketplaceAttachment[]
  >([]);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [supplyDiscoveryEnabled, setSupplyDiscoveryEnabled] = useState(
    copy.buyerDiscoveryDefault,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string | null>(null);
  const intentByTargetRef = useRef(
    new Map<string, { intentId: string; version: number }>(),
  );
  const focusInputAfterErrorRef = useRef(false);
  const submitMessageRef = useRef<
    ((rawText: string, session?: PartySession) => Promise<void>) | null
  >(null);
  const draftScope = useCallback(
    () => ({
      route: window.location.pathname,
      subplatform: subplatform.slug,
      role,
    }),
    [role, subplatform.slug],
  );
  const persistDraft = useCallback(
    (text: string, scope: ChatDraftScope = draftScope()) =>
      writeChatDraft(window.sessionStorage, scope, text),
    [draftScope],
  );
  const clearStoredDraft = useCallback(
    (scope: ChatDraftScope = draftScope()) =>
      clearChatDraft(window.sessionStorage, scope),
    [draftScope],
  );

  useEffect(() => {
    setMessage(readChatDraft(window.sessionStorage, draftScope()) ?? "");
  }, [draftScope]);

  useEffect(() => {
    const next = draftMessage?.trim();
    if (!next) return;
    setMessage(next);
    persistDraft(next);
    onDraftMessageApplied?.();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [draftMessage, onDraftMessageApplied, persistDraft]);

  const [sellerRouteChoices, setSellerRouteChoices] = useState<
    PlatformRouteHop[]
  >([]);
  const isRoot = subplatform.slug === "root";
  const isSeller = role === "seller";
  const mediaUploadEnabled =
    subplatform.agentMcpTools?.includes("media.upload") === true;
  const label = (key: string, fallback: string) =>
    subplatformCopy(
      subplatform,
      key,
      locale === "en" ? (englishChatLabels[key] ?? fallback) : fallback,
    );
  // Keep the primary action visually stable. A changing/typewriter headline delays
  // scanning and makes a marketplace feel like a demo; merchants may still
  // customize the static copy through the manifest.
  const headline = isSeller ? copy.sellerTitle : copy.buyerTitle;
  const showCompactMarketplaceHeading = compact && isRoot && !isSeller;
  let visibleHeadline = headline;
  let visibleDescription = isSeller
    ? copy.sellerDescription
    : copy.buyerDescription;
  if (showCompactMarketplaceHeading) {
    visibleHeadline = localeText(
      locale,
      "What are you looking for?",
      "想找什么？",
    );
    visibleDescription = localeText(
      locale,
      "Say what you need and your budget. Matching products will appear here.",
      "填写预算和需求，匹配的商品会出现在下方。",
    );
  }
  const hideMarketingHeading = home && !showCompactMarketplaceHeading;
  const homePlaceholder = homePlaceholderFor(
    locale,
    home && isRoot && !isSeller && !message && !composerFocused,
    subplatform.ui?.chat?.homePlaceholderPhrases,
  );
  let composerPlaceholder = copy.buyerPlaceholder;
  if (home && !isSeller) {
    composerPlaceholder = homePlaceholder;
  } else if (isSeller) {
    composerPlaceholder = copy.sellerPlaceholder;
  }
  const conversationStorageKey = `${SHOPPING_CONVERSATION_KEY}:${subplatform.slug}:${role}`;

  useEffect(() => {
    if (
      !conversationHydrated ||
      !conversationOwner ||
      !activeHistoryId ||
      !isRoot ||
      isSeller
    )
      return;
    const bounded = messages
      .slice(-MAX_CONVERSATION_MESSAGES)
      .map(({ id, role, text, choices, recommendations }) => ({
        id,
        role,
        text,
        ...(choices ? { choices } : {}),
        ...(recommendations ? { recommendations } : {}),
      }));
    window.sessionStorage.setItem(
      conversationStorageKey,
      JSON.stringify({
        owner: conversationOwner,
        id: activeHistoryId,
        messages: bounded,
      }),
    );
    if (!bounded.length) return;
    setConversationHistory(
      upsertConversationHistory({
        storage: window.localStorage,
        key: conversationHistoryStorageKey(conversationStorageKey),
        owner: conversationOwner,
        record: {
          id: activeHistoryId,
          title: locale === "en" ? "Conversation" : "对话",
          updatedAt: new Date().toISOString(),
          messages: bounded,
        },
        parseMessages: parseStoredMessages,
      }),
    );
  }, [
    activeHistoryId,
    conversationHydrated,
    conversationOwner,
    conversationStorageKey,
    isRoot,
    isSeller,
    locale,
    messages,
  ]);

  const resizeInput = useCallback((input: HTMLTextAreaElement | null) => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }, []);

  const shoppingPromises =
    locale === "en"
      ? ["Browse publicly", "Compare across stores", "Consent before contact"]
      : ["公开浏览", "跨店比较", "联系前征得同意"];
  const starterPromptCardsByLocale = {
    en: [
      {
        id: "describe",
        badge: "Start",
        title: "A family SUV within a 150,000 budget",
        desc: "Say what you need and your budget. Matching products will appear here.",
        prompt: "A family SUV within a 150,000 budget",
      },
      {
        id: "compare",
        badge: "Compare",
        title: "Compare a few suitable options",
        desc: "Explain the trade-offs using only offers already shown",
        prompt: "Compare a few suitable options and explain the trade-offs",
      },
      {
        id: "stores",
        badge: "Browse",
        title: "Find a reliable store",
        desc: "Find a store for this product without making verification claims",
        prompt: "Find a reliable store for this product",
      },
    ],
    zh: [
      {
        id: "describe",
        badge: "开始",
        title: "预算 15 万以内的家用 SUV",
        desc: "填写预算和需求，匹配的商品会出现在下方。",
        prompt: "预算 15 万以内，帮我找一台家用 SUV",
      },
      {
        id: "compare",
        badge: "比较",
        title: "比较几款合适的商品",
        desc: "只依据已展示商品和事实说明取舍",
        prompt: "比较几款合适的商品，并说明取舍",
      },
      {
        id: "stores",
        badge: "浏览",
        title: "找一家可靠的店铺",
        desc: "只列出当前公开店铺，不附加未经证实的认证声明",
        prompt: "帮我找一家可靠的店铺",
      },
    ],
  };
  const starterPromptCards = isRoot ? starterPromptCardsByLocale[locale] : [];

  const applyQuickPrompt = (value: string) => {
    setMessage(value);
    persistDraft(value);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      resizeInput(inputRef.current);
    });
  };

  useEffect(() => {
    resizeInput(inputRef.current);
  }, [message, resizeInput]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? "auto"
      : "smooth";
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
    if (!isRoot || isSeller) setMessages([]);
    setChatError(null);
    setSellerRouteChoices([]);
    setConversationAttachments([]);
    setSupplyDiscoveryEnabled(copy.buyerDiscoveryDefault);
    conversationIdRef.current = null;
    intentByTargetRef.current.clear();
  }, [copy.buyerDiscoveryDefault, isRoot, isSeller, role, subplatform.path]);

  const chooseSellerRoute = useCallback(
    async (target: PlatformRouteHop) => {
      if (!onSellerPlatformSelected || sending) return;
      setSending(true);
      try {
        await onSellerPlatformSelected(target);
        setSellerRouteChoices([]);
        setMessages((current) => [
          ...current,
          {
            id: `route-${crypto.randomUUID()}`,
            role: "assistant",
            text: runtime.sellerLocated(target.displayName),
          },
        ]);
        onNotice(runtime.sellerSwitched(target.displayName));
      } catch (error) {
        onNotice(
          error instanceof Error ? error.message : runtime.routeOpenError,
        );
      } finally {
        setSending(false);
      }
    },
    [locale, onNotice, onSellerPlatformSelected, sending],
  );

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !files.length || mediaUploading) return;
      if (!mediaUploadEnabled) return;
      if (!subplatform.tenantId || !subplatform.domainId) {
        onNotice(
          locale === "en"
            ? "This platform is not ready to receive attachments."
            : "当前平台尚未完成资料上传配置",
        );
        return;
      }
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role,
      });
      if (!session) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(
          `/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`,
        );
        return;
      }
      const remaining = Math.max(0, 8 - conversationAttachments.length);
      if (!remaining) {
        onNotice(
          locale === "en"
            ? "You can add up to 8 attachments."
            : "最多添加 8 个附件",
        );
        return;
      }
      setMediaUploading(true);
      try {
        const uploaded: MarketplaceAttachment[] = [];
        for (const file of Array.from(files).slice(0, remaining)) {
          uploaded.push(
            await uploadMarketplaceAttachment({
              platformPath: subplatform.path,
              tenantId: subplatform.tenantId,
              domainId: subplatform.domainId,
              file,
            }),
          );
        }
        setConversationAttachments((current) =>
          [...current, ...uploaded].slice(0, 8),
        );
        if (files.length > remaining)
          onNotice(
            locale === "en"
              ? "Only the first 8 attachments were kept."
              : "最多保留 8 个附件",
          );
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : localeText(
                locale,
                "Could not upload the attachment.",
                "附件上传失败，请稍后重试",
              );
        onNotice(detail);
      } finally {
        setMediaUploading(false);
      }
    },
    [
      conversationAttachments.length,
      locale,
      mediaUploadEnabled,
      mediaUploading,
      onNotice,
      role,
      subplatform.domainId,
      subplatform.path,
      subplatform.slug,
      subplatform.tenantId,
    ],
  );

  const submitMessage = useCallback(
    async (
      rawText: string,
      session?: PartySession,
      operationDraftScope: ChatDraftScope = draftScope(),
    ) => {
      const text = rawText.trim();
      if ((!text && !conversationAttachments.length) || sending) return;

      setSending(true);
      const failedUserMessageId = chatError?.failedUserMessageId;
      setChatError(null);
      setMessage("");
      const submittedAttachments = conversationAttachments;
      setConversationAttachments([]);
      const requestId = crypto.randomUUID();
      if (!conversationIdRef.current) {
        conversationIdRef.current = crypto.randomUUID();
      }
      const conversationId = conversationIdRef.current;
      const retryBaseMessages = failedUserMessageId
        ? messages.filter(
            (messageItem) => messageItem.id !== failedUserMessageId,
          )
        : messages;
      const narrative = buildConversationNarrative(
        retryBaseMessages
          .filter((item) => item.role === "user")
          .map((item) => item.text),
        text,
      );
      const userMessage: ChatMessage = {
        id: `${requestId}-user`,
        role: "user",
        text,
        ...(submittedAttachments.length
          ? { attachments: submittedAttachments }
          : {}),
      };
      setMessages([...retryBaseMessages, userMessage]);

      try {
        const live = isLiveMarketplaceEnabled();
        if (!live) {
          const detail = isSeller
            ? runtime.unavailableSupply
            : runtime.unavailableDemand;
          setChatError({
            detail,
            failedUserMessageId: userMessage.id,
            prompt: text,
          });
          setMessage(text);
          persistDraft(text, operationDraftScope);
          setConversationAttachments(submittedAttachments);
          focusInputAfterErrorRef.current = true;
          onNotice(detail);
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
          // Keep the conversational material when routing a seller to a child. The target
          // platform owns the schema, so this is deliberately an opaque editable draft rather
          // than guessed vehicle/service fields. The form or plugin can import it and the seller
          // still explicitly reviews and submits it.
          onSellerDraft?.({
            narrative,
            attributes: {
              source: "conversation",
              conversation_id: conversationId,
              routed_from: platformPath(subplatform),
              ...(submittedAttachments.length
                ? { attachments: submittedAttachments.map(publicAttachment) }
                : {}),
            },
            terms: { pricing_mode: pricingFor(subplatform).mode },
            ...(submittedAttachments.length
              ? { attachments: submittedAttachments }
              : {}),
          });
          // A seller must publish into the node selected by the platform Agent. The old flow
          // wrote supply intents into every hop and left the form mounted at the root path,
          // which made a successful route look like a dead end. Pick the deepest terminal hop
          // and let App load its package-owned schema before the form is rendered.
          const terminals = terminalRouteHops(route.routePlan).slice(
            0,
            MAX_CHAT_TARGETS,
          );
          if (terminals.length > 1) {
            setSellerRouteChoices(terminals);
            setMessages((current) => [
              ...current,
              {
                id: `${requestId}-assistant`,
                role: "assistant",
                text: runtime.multiplePlatforms,
              },
            ]);
            onNotice(runtime.choosePlatform);
            clearStoredDraft(operationDraftScope);
            return;
          }
          const target = terminals[0] ?? route.routePlan.at(-1) ?? null;
          if (target && onSellerPlatformSelected) {
            await onSellerPlatformSelected(target);
          }
          const selectedName =
            target?.displayName ||
            route.routePlan.at(-1)?.displayName ||
            runtime.targetPlatform;
          setMessages((current) => [
            ...current,
            {
              id: `${requestId}-assistant`,
              role: "assistant",
              text: runtime.sellerLocated(selectedName),
            },
          ]);
          onNotice(runtime.sellerSwitched(selectedName));
          clearStoredDraft(operationDraftScope);
          return;
        }
        const routedRecommendations: RecommendedBackendListing[] = [];
        let retrievalDegraded = false;
        let successfulTargetCount = 0;
        let firstTargetError: unknown = null;
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
                : (session ??
                  (await getMarketplaceSession({
                    subplatform: target.slug,
                    platformPath: target.path,
                    tenantId: target.tenantId,
                    domainId: targetDomainId,
                    role,
                  })));
              if (!targetSession) throw new Error(runtime.authDisconnected);
              const targetPricing = pricingFor(target);
              const targetUsesLegacy =
                target.marketplaceContract === "legacy-v1";
              const targetKey =
                target.path
                  .replace(/[^a-z0-9]+/gi, "-")
                  .replace(/^-|-$/g, "")
                  .slice(0, 96) || "root";
              if (isSeller) {
                // Keep seller conversations durable in the same intent as the buyer flow. A
                // seller may describe the same offer over several turns; creating a new supply
                // intent on every turn would fragment the listing and make the later editable
                // draft depend on whichever request happened to finish last.
                const supplyIntentState =
                  intentByTargetRef.current.get(targetKey);
                const supplyIntent = supplyIntentState
                  ? await updateMarketplaceIntent({
                      session: targetSession,
                      domainId: targetDomainId,
                      intentId: supplyIntentState.intentId,
                      narrative,
                      attributes: {
                        source: "conversation",
                        conversation_id: conversationId,
                        latest_turn: text,
                        platform_path: target.path,
                        ...(submittedAttachments.length
                          ? {
                              attachments:
                                submittedAttachments.map(publicAttachment),
                            }
                          : {}),
                      },
                      terms: {
                        pricing_mode: targetPricing.mode,
                        ...(targetPricing.currency
                          ? { currency: targetPricing.currency }
                          : {}),
                        ...(targetPricing.currencyScale === undefined
                          ? {}
                          : { currency_scale: targetPricing.currencyScale }),
                      },
                      expectedVersion: supplyIntentState.version,
                    })
                  : await createMarketplaceIntent({
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
                        ...(submittedAttachments.length
                          ? {
                              attachments:
                                submittedAttachments.map(publicAttachment),
                            }
                          : {}),
                      },
                      terms: {
                        pricing_mode: targetPricing.mode,
                        ...(targetPricing.currency
                          ? { currency: targetPricing.currency }
                          : {}),
                        ...(targetPricing.currencyScale === undefined
                          ? {}
                          : { currency_scale: targetPricing.currencyScale }),
                      },
                      idempotencyKey: `chat-${requestId}-${targetKey}`,
                    });
                if (
                  typeof supplyIntent.intent_id === "string" &&
                  typeof supplyIntent.version === "number"
                ) {
                  intentByTargetRef.current.set(targetKey, {
                    intentId: supplyIntent.intent_id,
                    version: supplyIntent.version,
                  });
                }
                // Keep the same opaque, scoped profile contract for supply as for demand. The
                // vertical Agent may later replace this conversation projection with typed fields;
                // the root never assumes that a supply is a vehicle, service, or another domain.
                void upsertMarketplaceProfile({
                  session: targetSession,
                  domainId: targetDomainId,
                  profile: {
                    kind: "supply_conversation",
                    conversation_id: conversationId,
                    narrative,
                    latest_turn: text,
                    turn_count:
                      messages.filter((item) => item.role === "user").length +
                      1,
                    source: "chat",
                  },
                }).catch(() => undefined);
                onSellerDraft?.({
                  narrative,
                  intentId:
                    typeof supplyIntent.intent_id === "string"
                      ? supplyIntent.intent_id
                      : undefined,
                  attributes: {
                    source: "conversation",
                    conversation_id: conversationId,
                    narrative,
                    ...(submittedAttachments.length
                      ? {
                          attachments:
                            submittedAttachments.map(publicAttachment),
                        }
                      : {}),
                  },
                  terms: { pricing_mode: targetPricing.mode },
                  ...(submittedAttachments.length
                    ? { attachments: submittedAttachments }
                    : {}),
                });
              } else if (targetUsesLegacy) {
                if (!targetPricing.currency)
                  throw new Error(
                    `${target.label || target.slug} 尚未配置结算币种，暂时不能生成真实推荐`,
                  );
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
                    ...(submittedAttachments.length
                      ? {
                          attachments:
                            submittedAttachments.map(publicAttachment),
                        }
                      : {}),
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
                routedRecommendations.push(
                  ...recommendations.map((item) => ({
                    ...item,
                    platform_path: target.path,
                    subplatform: target.slug,
                  })),
                );
              } else {
                const intentState = intentByTargetRef.current.get(targetKey);
                const intent = intentState
                  ? await updateMarketplaceIntent({
                      session: targetSession,
                      domainId: targetDomainId,
                      intentId: intentState.intentId,
                      narrative,
                      attributes: {
                        source: "conversation",
                        conversation_id: conversationId,
                        latest_turn: text,
                        ...(submittedAttachments.length
                          ? {
                              attachments:
                                submittedAttachments.map(publicAttachment),
                            }
                          : {}),
                      },
                      terms: {
                        pricing_mode: targetPricing.mode,
                        ...(targetPricing.currency
                          ? { currency: targetPricing.currency }
                          : {}),
                        ...(targetPricing.currencyScale === undefined
                          ? {}
                          : { currency_scale: targetPricing.currencyScale }),
                      },
                      expectedVersion: intentState.version,
                    })
                  : await createMarketplaceIntent({
                      session: targetSession,
                      domainId: targetDomainId,
                      side: "demand",
                      narrative,
                      attributes: {
                        source: "conversation",
                        conversation_id: conversationId,
                        ...(submittedAttachments.length
                          ? {
                              attachments:
                                submittedAttachments.map(publicAttachment),
                            }
                          : {}),
                      },
                      terms: {
                        pricing_mode: targetPricing.mode,
                        ...(targetPricing.currency
                          ? { currency: targetPricing.currency }
                          : {}),
                        ...(targetPricing.currencyScale === undefined
                          ? {}
                          : { currency_scale: targetPricing.currencyScale }),
                      },
                      supplyDiscoveryEnabled,
                      idempotencyKey: `chat-${requestId}-${targetKey}`,
                    });
                if (
                  typeof intent.intent_id === "string" &&
                  typeof intent.version === "number"
                ) {
                  intentByTargetRef.current.set(targetKey, {
                    intentId: intent.intent_id,
                    version: intent.version,
                  });
                }
                if (intentState && typeof intent.intent_id === "string") {
                  void updateMarketplaceDemandDiscovery({
                    session: targetSession,
                    domainId: targetDomainId,
                    intentId: intent.intent_id,
                    enabled: supplyDiscoveryEnabled,
                  }).catch(() => undefined);
                }
                // The root stores only a scoped, versioned understanding. Domain-specific fields
                // (for example vehicle attributes) are extracted by the active child Agent and
                // may replace this opaque conversation projection later.
                void upsertMarketplaceProfile({
                  session: targetSession,
                  domainId: targetDomainId,
                  profile: {
                    kind: "conversation",
                    conversation_id: conversationId,
                    narrative,
                    latest_turn: text,
                    turn_count:
                      messages.filter((item) => item.role === "user").length +
                      1,
                    source: "chat",
                  },
                }).catch(() => undefined);
                let retrievalCandidates: RecommendedBackendListing[] = [];
                let canonicalCandidates: Awaited<
                  ReturnType<typeof getMarketplaceOfferMatches>
                > | null = null;
                const recommendationContext = {
                  tenantId: target.tenantId,
                  domainId: targetDomainId,
                  platformPath: target.path,
                  subplatform: target.slug,
                  intentId: intent.intent_id,
                  fieldLabels: (attributes: Record<string, unknown>) =>
                    fieldLabelsFor(target, attributes, locale),
                };
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
                    // replace public offer fields or matcher evidence. Its explanations remain
                    // advisory provider_hints, and its score is never used.
                    canonicalCandidates = await getMarketplaceOfferMatches({
                      session: targetSession,
                      domainId: targetDomainId,
                      intentId: intent.intent_id,
                    });
                    retrievalCandidates = buildProviderSelectedRecommendations(
                      canonicalCandidates,
                      retrieval.candidates,
                      recommendationContext,
                    );
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
                  const candidates =
                    canonicalCandidates ??
                    (await getMarketplaceOfferMatches({
                      session: targetSession,
                      domainId: targetDomainId,
                      intentId: intent.intent_id,
                    }));
                  routedRecommendations.push(
                    ...buildCanonicalRecommendations(
                      candidates,
                      recommendationContext,
                    ),
                  );
                }
              }
              successfulTargetCount += 1;
            } catch (error) {
              // One child being offline must not erase matches already returned by other active
              // nodes. Keep the partial result and make the degraded state visible below.
              retrievalDegraded = true;
              firstTargetError ??= error;
            }
          };
          await runWithConcurrency(
            targets,
            CHAT_TARGET_CONCURRENCY,
            processTarget,
          );
          if (isSeller && successfulTargetCount === 0 && firstTargetError)
            throw firstTargetError;
          // A successful request with no candidates is still a new result. Clear
          // the previous cards instead of leaving stale offers on screen and
          // making them look like matches for the latest message.
          // A first answer should be scannable. Keep the default result set to three canonical
          // offers; later comparison can be expanded by the child-owned catalogue UI.
          onRecommendations?.(routedRecommendations.slice(0, 3));
        }
        const visibleRouteNames =
          route?.routePlan
            .slice(0, MAX_CHAT_TARGETS)
            .map((hop) => hop.displayName)
            .join(locale === "en" ? ", " : "、") || runtime.routeNode;
        const routeOverflowSuffix =
          route && route.routePlan.length > MAX_CHAT_TARGETS
            ? runtime.routeOverflow
            : "";
        let assistantText = runtime.recorded;
        if (isSeller) {
          assistantText = copy.sellerSuccess;
        } else if (live) {
          if (route?.status === "degraded" && route.routePlan.length) {
            assistantText = runtime.routeDegraded(
              visibleRouteNames,
              routeOverflowSuffix,
            );
          } else if (route?.routePlan.length) {
            assistantText = runtime.routeSelected(
              visibleRouteNames,
              routeOverflowSuffix,
            );
          } else if (route?.routing.source === "ai") {
            assistantText = runtime.noMatch;
          } else {
            assistantText = runtime.noChildren;
          }
        }
        const degradedSuffix = retrievalDegraded
          ? runtime.retrievalDegraded
          : "";
        setMessages((current) => [
          ...current,
          {
            id: `${requestId}-assistant`,
            role: "assistant",
            text: `${assistantText}${isSeller ? "" : degradedSuffix}`,
          },
        ]);
        let successNotice = isSeller ? copy.sellerSuccess : copy.buyerSuccess;
        if (retrievalDegraded) {
          successNotice = runtime.retrievalDegradedNotice;
        }
        onNotice(successNotice);
        clearStoredDraft(operationDraftScope);
        if (isSeller)
          window.setTimeout(
            () => document.getElementById("seller-display-name")?.focus(),
            0,
          );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : runtime.sendFailed;
        setChatError({
          detail,
          failedUserMessageId: userMessage.id,
          prompt: text,
          ...(error instanceof MarketplaceApiError && error.retryAfterMs
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
        });
        setMessage(text);
        persistDraft(text, operationDraftScope);
        setConversationAttachments(submittedAttachments);
        focusInputAfterErrorRef.current = true;
      } finally {
        setSending(false);
      }
    },
    [
      chatError,
      clearStoredDraft,
      conversationAttachments,
      copy.buyerSuccess,
      copy.sellerSuccess,
      draftScope,
      isSeller,
      locale,
      messages,
      onNotice,
      onRecommendations,
      onSellerDraft,
      onSellerPlatformSelected,
      persistDraft,
      resizeInput,
      role,
      sending,
      supplyDiscoveryEnabled,
      subplatform.domainId,
      subplatform.slug,
      subplatform.tenantId,
      subplatform.path,
    ],
  );

  submitMessageRef.current = submitMessage;

  const submitGuestMessage = useCallback(
    async (
      rawText: string,
      answeredChoice?: {
        messageId: string;
        choiceId: string;
        value: string;
      },
      operationDraftScope: ChatDraftScope = draftScope(),
    ) => {
      const text = rawText.trim();
      if (!text || sending) return;
      setSending(true);
      onSearchTrace?.(null);
      const failedUserMessageId = chatError?.failedUserMessageId;
      setChatError(null);
      setMessage("");
      const requestId = crypto.randomUUID();
      const userMessage: ChatMessage = {
        id: `${requestId}-user`,
        role: "user",
        text,
      };
      const retryBaseMessages = failedUserMessageId
        ? messages.filter(
            (messageItem) => messageItem.id !== failedUserMessageId,
          )
        : messages;
      const priorMessages = answeredChoice
        ? retryBaseMessages.map((messageItem) =>
            messageItem.id === answeredChoice.messageId
              ? {
                  ...messageItem,
                  choices: messageItem.choices?.map((choiceItem) =>
                    choiceItem.id === answeredChoice.choiceId
                      ? {
                          ...choiceItem,
                          selectedValue: answeredChoice.value,
                        }
                      : choiceItem,
                  ),
                }
              : messageItem,
          )
        : retryBaseMessages;
      const conversation = [...priorMessages, userMessage].slice(
        -MAX_CONVERSATION_MESSAGES,
      );
      setMessages(conversation);
      try {
        const conversationMessages = conversation.map(
          ({ role, text: content }) => ({ role, content }),
        );
        const reply =
          subplatform.slug === "root"
            ? await askMallShoppingAssistant(conversationMessages)
            : await askMallShoppingAssistant(conversationMessages, {
                storePath: subplatform.path,
              });
        const recommendations = mapRecommendations(
          reply.recommendations,
          subplatform,
          locale,
        );
        onRecommendations?.(reply.recommendations);
        onSearchTrace?.(reply.searchTrace ?? null);
        const assistantId = `${requestId}-assistant`;
        const handoff = (reply.uiActions ?? []).find(
          (action): action is MallAssistantHumanHandoffAction =>
            action.type === "human_handoff",
        );
        const contactConsent = (reply.uiActions ?? []).find(
          (action): action is MallAssistantContactConsentAction =>
            action.type === "contact_consent",
        );
        setMessages((current) => [
          ...current,
          {
            id: assistantId,
            role: "assistant",
            text: reply.answer,
            choices: (reply.uiActions ?? []).flatMap((action) =>
              action.type === "choice" ? [action] : [],
            ),
            ...(recommendations.length ? { recommendations } : {}),
            ...(handoff
              ? {
                  handoff: {
                    type: "human_handoff" as const,
                    requestId: reply.requestId,
                    conversionAttemptId: crypto.randomUUID(),
                    intent: handoff.intent,
                    productIds: handoff.productIds,
                    status: "confirmation_required" as const,
                  },
                }
              : {}),
            ...(contactConsent ? { contactConsent } : {}),
          },
        ]);
        clearStoredDraft(operationDraftScope);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : runtime.sendFailed;
        setChatError({
          detail,
          failedUserMessageId: userMessage.id,
          prompt: text,
          ...(error instanceof MarketplaceApiError && error.retryAfterMs
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
        });
        setMessage(text);
        persistDraft(text, operationDraftScope);
        focusInputAfterErrorRef.current = true;
      } finally {
        setSending(false);
      }
    },
    [
      chatError,
      clearStoredDraft,
      draftScope,
      locale,
      messages,
      onNotice,
      onRecommendations,
      onSearchTrace,
      persistDraft,
      runtime.sendFailed,
      sending,
      subplatform,
    ],
  );

  const confirmHumanHandoff = useCallback(
    async (messageId: string) => {
      const message = messages.find((item) => item.id === messageId);
      if (
        !message?.handoff ||
        !["confirmation_required", "failed"].includes(message.handoff.status) ||
        !onHumanHandoff
      )
        return;
      setMessages((current) =>
        current.map((item) =>
          item.id === messageId && item.handoff
            ? { ...item, handoff: { ...item.handoff, status: "sending" } }
            : item,
        ),
      );
      try {
        await onHumanHandoff({
          requestId: message.handoff.requestId,
          conversionAttemptId: message.handoff.conversionAttemptId,
          intent: message.handoff.intent,
          productIds: message.handoff.productIds,
        });
        setMessages((current) =>
          current.map((item) =>
            item.id === messageId && item.handoff
              ? { ...item, handoff: { ...item.handoff, status: "sent" } }
              : item,
          ),
        );
      } catch {
        setMessages((current) =>
          current.map((item) =>
            item.id === messageId && item.handoff
              ? { ...item, handoff: { ...item.handoff, status: "failed" } }
              : item,
          ),
        );
      }
    },
    [messages, onHumanHandoff],
  );

  const cancelHumanHandoff = useCallback(
    (messageId: string) => {
      const message = messages.find((item) => item.id === messageId);
      const pending = readPendingConversion();
      if (
        message?.handoff &&
        pending?.conversionAttemptId === message.handoff.conversionAttemptId
      )
        clearPendingConversion(pending.offerId);
      setMessages((current) =>
        current.map((item) =>
          item.id === messageId && item.handoff
            ? { ...item, handoff: { ...item.handoff, status: "cancelled" } }
            : item,
        ),
      );
    },
    [messages],
  );

  useEffect(() => {
    const pending = readPendingConversion();
    if (
      pending?.action !== "store_ai_handoff" ||
      pending.storePath !== subplatform.path ||
      !pending.intentLevel ||
      !pending.productIds
    )
      return;
    const intent = pending.intentLevel;
    const productIds = pending.productIds;
    const messageId = `pending-handoff-${pending.conversionAttemptId}`;
    setMessages((current) =>
      current.some((message) => message.id === messageId)
        ? current
        : [
            ...current,
            {
              id: messageId,
              role: "assistant",
              text:
                locale === "en"
                  ? "Your earlier handoff request is ready for confirmation."
                  : "已恢复登录前的人工介入请求，请再次确认是否通知店员。",
              handoff: {
                type: "human_handoff",
                requestId: `restored-${pending.conversionAttemptId}`,
                conversionAttemptId: pending.conversionAttemptId,
                intent,
                productIds,
                status: "confirmation_required",
              },
            },
          ],
    );
  }, [locale, subplatform.path]);

  useEffect(() => {
    let cancelled = false;
    if (isRoot && !isSeller) setConversationHydrated(false);
    void (async () => {
      const scopedMarketplace =
        subplatform.slug !== "root" && Boolean(subplatform.domainId);
      const session = scopedMarketplace
        ? await getMarketplaceSession({
            subplatform: subplatform.slug,
            platformPath: subplatform.path,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role,
          })
        : null;
      const authState = scopedMarketplace
        ? null
        : await authClient.getSession({
            fetchOptions: authFetchOptions(subplatform.slug),
          });
      if (cancelled) return;
      if (subplatform.domainId && !session) {
        setSignedIn(false);
        return;
      }
      const hasAuthSession = Boolean(session || authState?.data);
      setSignedIn(hasAuthSession);
      if (isRoot && !isSeller) {
        const authUserId = authState?.data?.user?.id;
        let owner = "guest";
        if (session?.partyId) {
          owner = `party:${session.partyId}`;
        } else if (typeof authUserId === "string" && authUserId) {
          owner = `user:${authUserId}`;
        }
        const storedConversation = readStoredConversation(
          conversationStorageKey,
          owner,
        );
        setConversationOwner(owner);
        setActiveHistoryId(storedConversation.id);
        setMessages(storedConversation.messages);
        setConversationHistory(
          readConversationHistory(
            window.localStorage,
            conversationHistoryStorageKey(conversationStorageKey),
            owner,
            parseStoredMessages,
          ),
        );
        setConversationHydrated(true);
      }
      const pending = readPendingChat();
      if (!pending) return;
      // A pending message is only a hand-off across the login page. Keep it until the user is
      // authenticated and still on the exact path it came from; otherwise a signed-out refresh
      // could consume it without a valid marketplace capability or send it to the wrong node.
      if (!hasAuthSession || pending.next !== currentLocation()) return;
      window.sessionStorage.removeItem(PENDING_CHAT_KEY);
      if (!cancelled)
        void submitMessageRef.current?.(pending.text, session ?? undefined);
    })().catch(() => {
      if (cancelled) return;
      setSignedIn(false);
      if (isRoot && !isSeller) {
        const owner = "guest";
        const storedConversation = readStoredConversation(
          conversationStorageKey,
          owner,
        );
        setConversationOwner(owner);
        setActiveHistoryId(storedConversation.id);
        setMessages(storedConversation.messages);
        setConversationHistory(
          readConversationHistory(
            window.localStorage,
            conversationHistoryStorageKey(conversationStorageKey),
            owner,
            parseStoredMessages,
          ),
        );
        setConversationHydrated(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    conversationStorageKey,
    isRoot,
    isSeller,
    role,
    subplatform.domainId,
    subplatform.slug,
    subplatform.tenantId,
  ]);

  const send = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = message.trim();
    if ((!text && !conversationAttachments.length) || sending) return;
    const operationDraftScope = draftScope();

    void (async () => {
      const scopedMarketplace =
        subplatform.slug !== "root" && Boolean(subplatform.domainId);
      const session = scopedMarketplace
        ? await getMarketplaceSession({
            subplatform: subplatform.slug,
            platformPath: subplatform.path,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role,
          })
        : null;
      const authState = scopedMarketplace
        ? null
        : await authClient.getSession({
            fetchOptions: authFetchOptions(subplatform.slug),
          });
      if (!isSeller) {
        setSignedIn(Boolean(session || authState?.data));
        void submitGuestMessage(text, undefined, operationDraftScope);
        return;
      }
      if (!session && !authState?.data) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.sessionStorage.setItem(
          PENDING_CHAT_KEY,
          JSON.stringify({ text, next } satisfies PendingChat),
        );
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      setSignedIn(true);
      void submitMessage(text, session ?? undefined, operationDraftScope);
    })().catch((error) =>
      onNotice(error instanceof Error ? error.message : runtime.authFailed),
    );
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const startNewConversation = useCallback(() => {
    if (sending) return;
    window.sessionStorage.removeItem(conversationStorageKey);
    clearStoredDraft();
    setActiveHistoryId(crypto.randomUUID());
    setChatError(null);
    setMessage("");
    setMessages([]);
    setConversationAttachments([]);
    setConversationHistoryOpen(false);
    onSearchTrace?.(null);
    conversationIdRef.current = null;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [clearStoredDraft, conversationStorageKey, onSearchTrace, sending]);

  const clearConversation = () => {
    if (sending) return;
    if (conversationOwner && activeHistoryId) {
      setConversationHistory(
        deleteConversationHistory({
          storage: window.localStorage,
          key: conversationHistoryStorageKey(conversationStorageKey),
          owner: conversationOwner,
          id: activeHistoryId,
          parseMessages: parseStoredMessages,
        }),
      );
    }
    startNewConversation();
  };

  const openHistoricalConversation = (
    conversation: ConversationHistoryRecord<ChatMessage>,
  ) => {
    if (sending) return;
    setActiveHistoryId(conversation.id);
    setChatError(null);
    setMessages(conversation.messages);
    setConversationAttachments([]);
    setConversationHistoryOpen(false);
    onSearchTrace?.(null);
    conversationIdRef.current = null;
    window.requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
      inputRef.current?.focus();
    });
  };

  const deleteHistoricalConversation = (id: string) => {
    if (!conversationOwner) return;
    setConversationHistory(
      deleteConversationHistory({
        storage: window.localStorage,
        key: conversationHistoryStorageKey(conversationStorageKey),
        owner: conversationOwner,
        id,
        parseMessages: parseStoredMessages,
      }),
    );
    if (id !== activeHistoryId) return;
    window.sessionStorage.removeItem(conversationStorageKey);
    setActiveHistoryId(crypto.randomUUID());
    setChatError(null);
    setMessages([]);
    setConversationAttachments([]);
    onSearchTrace?.(null);
    conversationIdRef.current = null;
  };

  useEffect(() => {
    const openConversationHistory = () => setConversationHistoryOpen(true);
    window.addEventListener(
      "matchplane:new-shopping-conversation",
      startNewConversation,
    );
    window.addEventListener(
      "matchplane:open-shopping-history",
      openConversationHistory,
    );
    return () => {
      window.removeEventListener(
        "matchplane:new-shopping-conversation",
        startNewConversation,
      );
      window.removeEventListener(
        "matchplane:open-shopping-history",
        openConversationHistory,
      );
    };
  }, [startNewConversation]);

  const chatActions = (
    <>
      <DropdownMenu size="sm">
        <DropdownMenuTrigger
          render={
            <Button
              className="match-chat-more-trigger"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={locale === "en" ? "Conversation options" : "对话选项"}
              title={locale === "en" ? "Conversation options" : "对话选项"}
            >
              <MoreHorizontal size={17} aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent
          className="match-chat-more-menu"
          align="end"
          sideOffset={8}
        >
          <DropdownMenuItem onClick={() => setConversationHistoryOpen(true)}>
            <History size={15} aria-hidden="true" />
            <span>{locale === "en" ? "History" : "历史"}</span>
          </DropdownMenuItem>
          {isRoot && !isSeller && signedIn ? (
            <DropdownMenuItem onClick={() => setShoppingMemoryOpen(true)}>
              <Brain size={15} aria-hidden="true" />
              <span>{locale === "en" ? "Memory" : "记忆"}</span>
            </DropdownMenuItem>
          ) : null}
          {messages.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="match-chat-clear-menu-item"
                disabled={sending}
                onClick={clearConversation}
              >
                <Trash2 size={15} aria-hidden="true" />
                <span>{label("clearChatLabel", "清空")}</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" aria-live="polite">
        {!sending && signedIn ? label("signedInChatStatus", "已登录") : ""}
      </span>
    </>
  );

  return (
    <section
      className={
        home
          ? `home-chat w-full${messages.length || sending || chatError ? " has-conversation" : ""}`
          : "match-chat" +
            (isRoot ? " is-root" : "") +
            (isSeller ? " is-seller" : "") +
            (compact ? " is-catalog-header" : "")
      }
      aria-labelledby="match-chat-title"
    >
      <div
        className={
          hideMarketingHeading
            ? "home-chat-a11y-heading sr-only"
            : "match-chat-heading"
        }
      >
        {hideMarketingHeading ? (
          <h2 id="match-chat-title">
            {locale === "en" ? "Shopping conversation" : "购物对话"}
          </h2>
        ) : (
          <div>
            {home ? (
              <h2 id="match-chat-title">{visibleHeadline}</h2>
            ) : (
              <h1 id="match-chat-title">{visibleHeadline}</h1>
            )}
            <p>{visibleDescription}</p>
            {isRoot && !isSeller && !compact ? (
              <ul
                className="match-chat-promises"
                aria-label={
                  locale === "en" ? "Search capabilities" : "搜索能力"
                }
              >
                {shoppingPromises.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        {home ? null : <div className="match-chat-actions">{chatActions}</div>}
      </div>

      {isRoot && !isSeller ? (
        <ConversationHistoryPanel
          activeId={activeHistoryId}
          conversations={conversationHistory}
          locale={locale}
          onClose={() => setConversationHistoryOpen(false)}
          onDelete={deleteHistoricalConversation}
          onOpen={openHistoricalConversation}
          onStartNew={startNewConversation}
          open={conversationHistoryOpen}
        />
      ) : null}

      {isRoot && !isSeller && shoppingMemoryOpen ? (
        <ShoppingMemoryPanel
          open
          onClose={() => setShoppingMemoryOpen(false)}
          locale={locale === "en" ? "en" : "zh"}
        />
      ) : null}

      {messages.length || sending ? (
        <div
          ref={threadRef}
          className={
            home
              ? "home-chat-thread mt-6 grid max-h-80 gap-5 overflow-y-auto px-1 py-2"
              : "match-chat-thread"
          }
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label={label("chatThreadLabel", "对话记录")}
        >
          {messages.map((item) => (
            <div
              key={item.id}
              className={`match-chat-message-group is-${item.role}`}
            >
              {item.role === "assistant" ? (
                <div className="match-chat-assistant-tag" aria-hidden="true">
                  <Sparkles size={12} />
                  <span>{assistantRoleLabel(subplatform.slug, locale)}</span>
                </div>
              ) : null}
              <p className={`match-chat-message is-${item.role}`}>
                {item.text}
              </p>
              {item.choices?.map((choice) => (
                <fieldset
                  key={choice.id}
                  className="match-chat-tool-choice"
                  aria-label={choice.question}
                >
                  <strong>{choice.question}</strong>
                  <div>
                    {choice.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={choice.selectedValue === option.value}
                        disabled={sending || Boolean(choice.selectedValue)}
                        onClick={() =>
                          void submitGuestMessage(option.value, {
                            messageId: item.id,
                            choiceId: choice.id,
                            value: option.value,
                          })
                        }
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
              {item.contactConsent ? (
                <StoreContactConsentCard
                  action={item.contactConsent}
                  locale={locale}
                  onAgree={onContactConsent}
                  onRetrieve={onContactRetrieve}
                />
              ) : null}
              {item.handoff ? (
                <div
                  className={`match-chat-handoff is-${item.handoff.status}`}
                  role={item.handoff.status === "failed" ? "alert" : "status"}
                >
                  <strong>
                    {handoffStatusLabel(item.handoff.status, locale)}
                  </strong>
                  <span>
                    {item.handoff.status === "failed"
                      ? locale === "en"
                        ? "You can keep chatting and try the handoff again later. Only structured shopping intent and selected offer IDs are shared."
                        : "你可以继续对话，稍后再请求人工介入。只会共享结构化购买意向和已选商品编号。"
                      : locale === "en"
                        ? "You can keep chatting here. Only your structured shopping intent and selected offer IDs will be shared. Chat text and contact details are excluded."
                        : "可以继续在这里咨询。只会共享结构化购买意向和已选商品编号；不会共享聊天原文或联系方式。"}
                  </span>
                  {item.handoff.status === "confirmation_required" ||
                  item.handoff.status === "failed" ? (
                    <div className="match-chat-handoff-actions">
                      <Button
                        type="button"
                        className="match-chat-handoff-confirm"
                        onClick={() => void confirmHumanHandoff(item.id)}
                      >
                        {handoffActionLabel(item.handoff.status, locale)}
                      </Button>
                      {item.handoff.status === "confirmation_required" ? (
                        <Button
                          type="button"
                          className="match-chat-handoff-cancel"
                          onClick={() => cancelHumanHandoff(item.id)}
                        >
                          {locale === "en" ? "Not now" : "暂不通知"}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {item.recommendations?.length && !home ? (
                <section
                  className="match-chat-recommendations"
                  aria-label={
                    locale === "en" ? "Recommended products" : "推荐商品"
                  }
                >
                  {item.recommendations.map((recommendation) => (
                    <MarketplaceListingCard
                      compact
                      key={recommendation.id}
                      listing={recommendation}
                      locale={locale}
                      onOpen={() => onOpenListing?.(recommendation)}
                      onLike={
                        onLikeListing &&
                        (recommendation.offerId ??
                          listingIdFromBackend(recommendation))
                          ? () => onLikeListing(recommendation)
                          : undefined
                      }
                    />
                  ))}
                </section>
              ) : null}
              {item.attachments?.length ? (
                <ul
                  className="match-chat-attachments"
                  aria-label={locale === "en" ? "Attachments" : "附件"}
                >
                  {item.attachments.map((attachment) => (
                    <li key={attachment.attachment_ref}>
                      {attachment.file_name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          {sending ? (
            <div className="match-chat-message-group is-assistant">
              <div className="match-chat-assistant-tag" aria-hidden="true">
                <Sparkles size={12} />
                <span>{assistantRoleLabel(subplatform.slug, locale)}</span>
              </div>
              <AssistantThinkingStatus
                locale={locale}
                mode={isSeller ? "seller" : isRoot ? "shopping" : "store"}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {sellerRouteChoices.length ? (
        <fieldset
          className="match-chat-route-choices"
          aria-label={runtime.routeChoicesAria}
        >
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
        </fieldset>
      ) : null}

      {mediaUploadEnabled && conversationAttachments.length ? (
        <ul
          className="match-chat-compose-attachments"
          aria-label={locale === "en" ? "Attachments to send" : "待发送附件"}
        >
          {conversationAttachments.map((attachment) => (
            <li key={attachment.attachment_ref}>
              <span title={attachment.file_name}>{attachment.file_name}</span>
              <button
                type="button"
                aria-label={`${locale === "en" ? "Remove" : "移除"} ${attachment.file_name}`}
                onClick={() =>
                  setConversationAttachments((current) =>
                    current.filter(
                      (item) =>
                        item.attachment_ref !== attachment.attachment_ref,
                    ),
                  )
                }
                disabled={sending || mediaUploading}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {chatError ? (
        <div className="home-chat-error" role="alert">
          <span className="home-chat-error-copy">
            <strong>
              {locale === "en"
                ? "That reply did not complete"
                : "这次没有完成回复"}
            </strong>
            <span>
              {chatError.detail}{" "}
              {formatRetryTiming(chatError.retryAfterMs, locale)}
            </span>
            <small>
              {locale === "en"
                ? "Your message and attachments are kept for retry."
                : "原输入和附件仍会保留，可直接重试。"}
            </small>
          </span>
          <button
            type="button"
            onClick={() => inputRef.current?.form?.requestSubmit()}
            disabled={sending || mediaUploading}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {locale === "en" ? "Retry answer" : "重试回答"}
          </button>
        </div>
      ) : null}
      <form
        className={
          home ? "home-chat-form flex items-end gap-3" : "match-chat-form"
        }
        onSubmit={send}
      >
        {mediaUploadEnabled ? (
          <label
            className={
              home
                ? "home-chat-attach relative grid size-14 shrink-0 cursor-pointer place-items-center rounded-xl bg-background text-foreground-muted"
                : "match-chat-attach"
            }
            htmlFor="match-chat-attachment-input"
          >
            <FileUp size={17} aria-hidden="true" />
            <span className="sr-only">
              {locale === "en" ? "Add attachment" : "添加附件"}
            </span>
            <input
              id="match-chat-attachment-input"
              type="file"
              accept="image/*,application/pdf,text/plain,application/json"
              multiple
              onChange={(event) => {
                void uploadFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
              disabled={sending || mediaUploading}
            />
          </label>
        ) : null}
        <label className="sr-only" htmlFor="match-chat-input">
          {isSeller
            ? `${label("tellPlatformPrefix", "告诉 MatchPlane")} ${copy.sellerTitle}`
            : label("chatInputLabel", "告诉 MatchPlane 你的需求")}
        </label>
        <Textarea
          ref={inputRef}
          id="match-chat-input"
          className={
            home
              ? "home-chat-input min-h-14 max-h-40 flex-1 resize-none"
              : undefined
          }
          value={message}
          onChange={(event) => {
            const next = event.target.value;
            setMessage(next);
            persistDraft(next);
            resizeInput(event.currentTarget);
          }}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          onKeyDown={handleInputKeyDown}
          placeholder={composerPlaceholder}
          rows={home ? 1 : 2}
          maxLength={10000}
          aria-describedby="match-chat-footnote"
          readOnly={sending}
          aria-disabled={sending}
        />
        <Button
          className={
            home ? "home-chat-send size-14 shrink-0" : "match-chat-send"
          }
          size="icon-md"
          type="submit"
          aria-label={
            isSeller
              ? label("sendSupplyLabel", "发送供给")
              : label("sendDemandLabel", "发送需求")
          }
          aria-busy={sending}
          disabled={
            (!message.trim() && !conversationAttachments.length) || sending
          }
        >
          <MatchChatMetalHalo
            active={
              composerFocused &&
              Boolean(message.trim() || conversationAttachments.length) &&
              !sending
            }
          />
          <span className="relative z-10 inline-flex">
            {sending ? (
              <LoaderCircle
                className="match-chat-spinner"
                size={18}
                aria-hidden="true"
              />
            ) : (
              <ArrowUp size={18} aria-hidden="true" />
            )}
          </span>
        </Button>
        {home ? <div className="home-chat-toolbar">{chatActions}</div> : null}
      </form>
      {isRoot && !isSeller && !messages.length ? (
        <section
          className="match-chat-suggestions"
          aria-label={
            locale === "en" ? "Example shopping requests" : "购物需求示例"
          }
        >
          <div className="match-chat-starter-title-row">
            <Compass size={14} aria-hidden="true" />
            <span>{locale === "en" ? "Try asking" : "可以这样开始"}</span>
          </div>

          <div className="match-chat-starter-grid">
            {starterPromptCards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="match-chat-starter-card"
                onClick={() => {
                  if (isRoot && !isSeller) {
                    void submitGuestMessage(card.prompt);
                  } else {
                    applyQuickPrompt(card.prompt);
                  }
                }}
              >
                <div className="match-chat-starter-card-top">
                  <span className="match-chat-starter-badge">{card.badge}</span>
                  <ArrowUpRight
                    size={13}
                    className="match-chat-starter-arrow"
                    aria-hidden="true"
                  />
                </div>
                <strong className="match-chat-starter-title">
                  {card.title}
                </strong>
                <span className="match-chat-starter-desc">{card.desc}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {!isSeller && signedIn && !isRoot ? (
        <label className="match-chat-discovery">
          <input
            type="checkbox"
            checked={supplyDiscoveryEnabled}
            onChange={(event) =>
              setSupplyDiscoveryEnabled(event.currentTarget.checked)
            }
            disabled={sending}
          />
          <span>{copy.buyerDiscoveryLabel}</span>
        </label>
      ) : null}
      <p
        id="match-chat-footnote"
        className={home ? "sr-only" : "match-chat-footnote"}
      >
        {isSeller ? copy.sellerFootnote : copy.buyerFootnote}
      </p>
    </section>
  );
}

function fieldLabelsFor(
  subplatform: SubplatformConfig,
  attributes: Record<string, unknown>,
  locale: InterfaceLocale,
): Record<string, string> {
  return Object.keys(attributes)
    .slice(0, 32)
    .reduce<Record<string, string>>((labels, key) => {
      labels[key] = subplatformFieldLabel(subplatform, key, locale);
      return labels;
    }, {});
}

function publicAttachment(
  attachment: MarketplaceAttachment,
): Record<string, unknown> {
  return {
    attachment_ref: attachment.attachment_ref,
    kind: attachment.kind,
    file_name: attachment.file_name,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
    ...(attachment.duration_ms === undefined
      ? {}
      : { duration_ms: attachment.duration_ms }),
    ...(attachment.metadata === undefined
      ? {}
      : { metadata: attachment.metadata }),
  };
}

/** Keep seller-side follow-up requests useful without storing an unbounded browser transcript. */
function buildConversationNarrative(
  previousRequests: string[],
  currentRequest: string,
): string {
  const recent = previousRequests
    .slice(-4)
    .map(
      (value, index) =>
        `第${index + 1}条已知需求：${value.trim().slice(0, 1_200)}`,
    )
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
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (item !== undefined) await worker(item);
      }
      return undefined;
    }),
  );
}

function platformPath(subplatform: SubplatformConfig): string {
  return (
    subplatform.path ||
    (subplatform.slug === "root" ? "/" : `/${subplatform.slug}`)
  );
}

function readPendingChat(): PendingChat | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingChat;
    if (
      typeof parsed.text !== "string" ||
      !parsed.text.trim() ||
      parsed.text.length > 10000
    )
      return null;
    if (typeof parsed.next !== "string" || !isSafePendingLocation(parsed.next))
      return null;
    return { text: parsed.text.trim(), next: parsed.next };
  } catch {
    return null;
  }
}

function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function isSafePendingLocation(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !hasControlCharacter
  );
}

/** Return the first deepest route node; intermediate platform nodes are aggregation boundaries. */
function terminalRouteHops(routePlan: PlatformRouteHop[]): PlatformRouteHop[] {
  const terminals = routePlan.filter(
    (candidate) =>
      !routePlan.some(
        (other) =>
          other.path !== candidate.path &&
          other.path.startsWith(`${candidate.path}/`),
      ),
  );
  const unique = new Map(
    terminals.map((candidate) => [candidate.path, candidate]),
  );
  return [...unique.values()];
}
