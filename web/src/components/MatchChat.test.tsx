import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MallAssistantSearchTrace,
  MallAssistantUiAction,
  RecommendedBackendListing,
} from "../api";

type AssistantReplyFixture = {
  requestId: string;
  answer: string;
  recommendations: RecommendedBackendListing[];
  uiActions: MallAssistantUiAction[];
  searchTrace?: MallAssistantSearchTrace;
  outcome?: "empty_catalog" | "no_matching_products";
};

const routePromise = vi.hoisted(() => ({
  current: null as Promise<AssistantReplyFixture> | null,
}));
const resolveRoute = vi.hoisted(() => ({
  current: null as (() => void) | null,
}));
const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
);
const askMallShoppingAssistant = vi.hoisted(() =>
  vi.fn(
    async (
      _messages: Array<{ role: "user" | "assistant"; content: string }>,
    ): Promise<AssistantReplyFixture> => ({
      requestId: "22222222-2222-4222-8222-222222222222",
      answer: "这是模型生成的导购回答。",
      recommendations: [],
      uiActions: [],
    }),
  ),
);
const createMarketplaceIntent = vi.hoisted(() => vi.fn());
const routePlatformIntent = vi.hoisted(() => vi.fn());
const uploadMarketplaceAttachment = vi.hoisted(() => vi.fn());
const upsertMarketplaceProfile = vi.hoisted(() => vi.fn());
const getMarketplaceSession = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth-client", () => ({
  authClient: { getSession },
  authFetchOptions: () => ({}),
}));

vi.mock("../lib/marketplace-session", () => ({
  getMarketplaceSession,
}));

vi.mock("./MatchChatMetalHalo", () => ({
  MatchChatMetalHalo: ({ active }: { active: boolean }) => (
    <span data-match-chat-metal data-active={String(active)} />
  ),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isLiveMarketplaceEnabled: () => true,
  askMallShoppingAssistant,
  createMarketplaceIntent,
  routePlatformIntent,
  uploadMarketplaceAttachment,
  upsertMarketplaceProfile,
}));

import { MarketplaceApiError } from "../api";
import { MatchChat } from "./MatchChat";
import type { SubplatformConfig } from "../subplatform";

const subplatform = {
  slug: "root",
  path: "/",
  label: "MatchPlane",
  ui: {},
} as SubplatformConfig;

afterEach(() => {
  resolveRoute.current?.();
  routePromise.current = null;
  resolveRoute.current = null;
  askMallShoppingAssistant.mockReset();
  createMarketplaceIntent.mockReset();
  routePlatformIntent.mockReset();
  uploadMarketplaceAttachment.mockReset();
  upsertMarketplaceProfile.mockReset();
  getMarketplaceSession.mockReset();
});

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { user: { id: "user-1" } } });
  askMallShoppingAssistant.mockResolvedValue({
    requestId: "22222222-2222-4222-8222-222222222222",
    answer: "这是模型生成的导购回答。",
    recommendations: [],
    uiActions: [],
  });
  getMarketplaceSession.mockResolvedValue({
    tenantId: "11111111-1111-4111-8111-111111111111",
    partyId: "22222222-2222-4222-8222-222222222222",
    role: "seller",
    accessToken: "seller-session",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  routePlatformIntent.mockResolvedValue({
    requestId: "33333333-3333-4333-8333-333333333333",
    platformPath: "/tools",
    status: "accepted",
    routePlan: [],
    routing: {
      selectedSlugs: [],
      source: "policy_fallback",
      model: null,
      rationale: "No child route required",
      confidence: null,
      degraded: false,
      costBearer: "platform",
      budget: { maxInputCharacters: 10_000, maxOutputTokens: 512 },
      usage: null,
    },
  });
  uploadMarketplaceAttachment.mockResolvedValue({
    attachment_ref: "media://tools/offer.pdf",
    kind: "document",
    file_name: "offer.pdf",
    media_type: "application/pdf",
    size_bytes: 7,
    sha256: "a".repeat(64),
  });
  createMarketplaceIntent.mockResolvedValue({
    intent_id: "44444444-4444-4444-8444-444444444444",
    version: 1,
  });
  upsertMarketplaceProfile.mockResolvedValue({});
});

describe("MatchChat sending state", () => {
  it("does not expose one signed-in account's transcript to another", async () => {
    const key = "matchplane.shopping-conversation.v1:root:buyer";
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        owner: "user:user-1",
        messages: [
          { id: "private-1", role: "user", text: "只属于账号一的秘密" },
        ],
      }),
    );
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    expect(await screen.findByText("只属于账号一的秘密")).toBeInTheDocument();
    first.unmount();

    getSession.mockResolvedValue({ data: { user: { id: "user-2" } } });
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(screen.queryByText("只属于账号一的秘密")).not.toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        window.sessionStorage.getItem(key) ?? "null",
      ) as {
        owner?: string;
      } | null;
      expect(stored?.owner).toBe("user:user-2");
    });
  });
  it("resets prior provenance while keeping visible search progress until a result arrives", async () => {
    const user = userEvent.setup();
    const onSearchTrace = vi.fn();
    askMallShoppingAssistant.mockImplementation(() => {
      routePromise.current = new Promise((resolve) => {
        resolveRoute.current = () =>
          resolve({
            requestId: "22222222-2222-4222-8222-222222222222",
            answer: "这是模型生成的导购回答。",
            recommendations: [],
            uiActions: [],
          });
      });
      return routePromise.current;
    });
    render(
      <MatchChat
        home
        onNotice={vi.fn()}
        onSearchTrace={onSearchTrace}
        subplatform={subplatform}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    const halo = document.querySelector("[data-match-chat-metal]");

    expect(input).not.toHaveFocus();
    expect(halo).toHaveAttribute("data-active", "false");
    await user.type(input, "寻找合适的方案");
    expect(input).toHaveFocus();
    expect(halo).toHaveAttribute("data-active", "true");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(onSearchTrace).toHaveBeenCalledWith(null);
    expect(
      screen.getByRole("status", { name: "正在回复…" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("status", { name: "正在回复…" })[0],
    ).toHaveTextContent("正在检索公开店铺");
    expect(screen.getByText("寻找合适的方案")).toBeInTheDocument();
    expect(screen.queryByText(/我先|AI 已|整理成一份/)).not.toBeInTheDocument();
    expect(document.querySelector(".assistant-thinking-status")).not.toBeNull();
    expect(
      document.querySelector(
        '[data-assistant-liquid][data-activity="shopping"]',
      ),
    ).toHaveAttribute("aria-hidden", "true");
    expect(halo).toHaveAttribute("data-active", "false");

    expect(document.querySelector(".home-chat")).toHaveClass(
      "has-conversation",
    );
    expect(
      document
        .querySelector(".chat-typing-indicator")
        ?.closest(".home-chat-thread"),
    ).not.toBeNull();

    resolveRoute.current?.();
    expect(
      await screen.findByText("这是模型生成的导购回答。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "正在回复…" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-assistant-liquid]")).toBeNull();
  });

  it("keeps a failed request reason retryable after resetting prior provenance", async () => {
    const user = userEvent.setup();
    const onSearchTrace = vi.fn();
    askMallShoppingAssistant.mockRejectedValueOnce(
      new MarketplaceApiError(429, "请求过于频繁，请稍后再试。", {
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 90_000,
      }),
    );
    render(
      <MatchChat
        home
        onNotice={vi.fn()}
        onSearchTrace={onSearchTrace}
        subplatform={subplatform}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "帮我找啊");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    const alert = await screen.findByRole("alert");
    expect(onSearchTrace).toHaveBeenCalledWith(null);
    expect(alert).toHaveTextContent("请求过于频繁，请稍后再试。");
    expect(alert).toHaveTextContent("建议约 2 分钟后重试。");
    expect(input).toHaveValue("帮我找啊");
    expect(
      document.querySelectorAll(".match-chat-message.is-user"),
    ).toHaveLength(1);
    expect(
      document.querySelector(".match-chat-message.is-assistant"),
    ).toBeNull();
    expect(document.querySelector("[data-assistant-liquid]")).toBeNull();

    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "44444444-4444-4444-8444-444444444444",
      answer: "可以。你具体想找什么？",
      recommendations: [],
      uiActions: [],
    });
    await user.click(screen.getByRole("button", { name: "重试回答" }));

    expect(
      await screen.findByText("可以。你具体想找什么？"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector("[data-assistant-liquid]")).toBeNull();
    expect(
      document.querySelectorAll(".match-chat-message.is-user"),
    ).toHaveLength(1);
    expect(input).toHaveValue("");
    expect(askMallShoppingAssistant.mock.calls[1]?.[0]).toEqual([
      { role: "user", content: "帮我找啊" },
    ]);
  });

  it("keeps a failed request retryable without turning the error into an assistant message", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant.mockRejectedValueOnce(
      new Error("商品搜索暂时不可用"),
    );
    render(<MatchChat home onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "帮我找啊");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("商品搜索暂时不可用");
    expect(input).toHaveValue("帮我找啊");
    expect(
      document.querySelector(".match-chat-message.is-assistant"),
    ).toBeNull();

    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "44444444-4444-4444-8444-444444444444",
      answer: "可以。你具体想找什么？",
      recommendations: [],
      uiActions: [],
    });
    await user.click(screen.getByRole("button", { name: "重试回答" }));

    expect(
      await screen.findByText("可以。你具体想找什么？"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders a typed empty catalog result as a completed answer", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "55555555-5555-4555-8555-555555555555",
      answer: "当前公开目录里暂时还没有可推荐的商品。",
      recommendations: [],
      uiActions: [],
      outcome: "empty_catalog",
    });
    render(<MatchChat home onNotice={vi.fn()} subplatform={subplatform} />);

    await user.type(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
      "现在有什么商品？",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      await screen.findByText("当前公开目录里暂时还没有可推荐的商品。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector(".match-chat-recommendations")).toBeNull();
  });

  it.each([
    503, 504,
  ] as const)("keeps a seller %i retryable with its prompt and attachment intact", async (status) => {
    const user = userEvent.setup();
    const onSellerDraft = vi.fn();
    const sellerSubplatform = {
      slug: "tools",
      path: "/tools",
      label: "工具平台",
      tenantId: "11111111-1111-4111-8111-111111111111",
      domainId: "55555555-5555-4555-8555-555555555555",
      pricing: { mode: "none" },
      marketplaceContract: "generic-v1",
      agentMcpTools: ["media.upload"],
      ui: {},
    } as SubplatformConfig;
    const detail =
      status === 504
        ? "下游平台响应超时，请稍后重试。"
        : "下游平台内部工具暂时不可用，请稍后重试。";
    createMarketplaceIntent.mockRejectedValueOnce(
      new MarketplaceApiError(status, detail, {
        code: status === 504 ? "gateway_timeout" : "provider_tool_failure",
        retryable: true,
        retryAfterMs: 5_000,
      }),
    );
    render(
      <MatchChat
        onNotice={vi.fn()}
        onSellerDraft={onSellerDraft}
        role="seller"
        subplatform={sellerSubplatform}
      />,
    );
    const input = screen.getByRole("textbox");
    const attachmentInput = screen.getByLabelText("添加附件");

    await user.upload(
      attachmentInput,
      new File(["details"], "offer.pdf", { type: "application/pdf" }),
    );
    await screen.findByText("offer.pdf");
    await user.type(input, "我可以提供耐用的专业工具");
    await user.click(screen.getByRole("button", { name: "发送供给" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(detail);
    expect(alert).toHaveTextContent("建议约 5 秒后重试。");
    expect(input).toHaveValue("我可以提供耐用的专业工具");
    expect(
      document.querySelector(".match-chat-compose-attachments"),
    ).toHaveTextContent("offer.pdf");
    expect(
      document.querySelectorAll(".match-chat-message.is-user"),
    ).toHaveLength(1);
    expect(
      document.querySelector(".match-chat-message.is-assistant"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "重试回答" }));

    expect(
      await screen.findByText(
        "供给描述已整理；请在下方提交资料，提交后才会写入系统",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(
      document.querySelector(".match-chat-compose-attachments"),
    ).toBeNull();
    expect(
      document.querySelectorAll(".match-chat-message.is-user"),
    ).toHaveLength(1);
    expect(createMarketplaceIntent).toHaveBeenCalledTimes(2);
    expect(onSellerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            attachment_ref: "media://tools/offer.pdf",
            file_name: "offer.pdf",
          }),
        ],
      }),
    );
  });

  it("restores visible conversation history for the same signed-in owner", async () => {
    window.sessionStorage.setItem(
      "matchplane.shopping-conversation.v1:root:buyer",
      JSON.stringify({
        owner: "user:user-1",
        messages: [
          { id: "history-user", role: "user", text: "第一条历史需求" },
          {
            id: "history-assistant",
            role: "assistant",
            text: "第一条历史回复",
          },
        ],
      }),
    );

    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);

    expect(await screen.findByText("第一条历史需求")).toBeInTheDocument();
    expect(screen.getByText("第一条历史回复")).toBeInTheDocument();
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
  });

  it("starts a genuinely new conversation from the marketplace rail", async () => {
    window.sessionStorage.setItem(
      "matchplane.shopping-conversation.v1:root:buyer",
      JSON.stringify({
        owner: "user:user-1",
        messages: [
          { id: "history-user", role: "user", text: "准备清空的需求" },
          {
            id: "history-assistant",
            role: "assistant",
            text: "准备清空的回复",
          },
        ],
      }),
    );
    render(<MatchChat home onNotice={vi.fn()} subplatform={subplatform} />);
    expect(await screen.findByText("准备清空的需求")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("matchplane:new-shopping-conversation"));
    });

    await waitFor(() =>
      expect(screen.queryByText("准备清空的需求")).not.toBeInTheDocument(),
    );
    expect(
      JSON.parse(
        window.sessionStorage.getItem(
          "matchplane.shopping-conversation.v1:root:buyer",
        ) ?? "{}",
      ).messages,
    ).toEqual([]);
  });

  it("hands home results and their trace to the page without duplicating product cards", async () => {
    const user = userEvent.setup();
    const recommendation = {
      listing_id: "66666666-6666-4666-8666-666666666666",
      display_name: "照片可见的商品",
      store_name: "影像店",
      platform_path: "/camera",
      asking_amount: "12900",
      currency: "CNY",
      currency_scale: 2,
      attributes: {
        attachments: [
          {
            kind: "image",
            public_url: "https://images.example.test/product.jpg",
          },
        ],
      },
    } satisfies RecommendedBackendListing;
    const searchTrace: MallAssistantSearchTrace = {
      source: "visible_recommendations",
      resultCount: 1,
      stores: [{ path: "/camera", displayName: "影像店", offerCount: 1 }],
    };
    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "55555555-5555-4555-8555-555555555555",
      answer: "找到一件符合条件的商品。",
      recommendations: [recommendation],
      uiActions: [],
      searchTrace,
    });
    const onRecommendations = vi.fn();
    const onSearchTrace = vi.fn();
    render(
      <MatchChat
        home
        onNotice={vi.fn()}
        onRecommendations={onRecommendations}
        onSearchTrace={onSearchTrace}
        subplatform={subplatform}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
      "给我看看照片",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      await screen.findByText("找到一件符合条件的商品。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "照片可见的商品" }),
    ).not.toBeInTheDocument();
    expect(onRecommendations).toHaveBeenCalledWith([recommendation]);
    expect(onSearchTrace).toHaveBeenNthCalledWith(1, null);
    expect(onSearchTrace).toHaveBeenNthCalledWith(2, searchTrace);
  });

  it("shows match reasons on search result cards so users can verify retrieval", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "77777777-7777-4777-8777-777777777777",
      answer: "按预算筛了几台在售 SUV，可以点开看。",
      recommendations: [
        {
          offer_id: "88888888-8888-4888-8888-888888888888",
          display_name: "本田 CR-V",
          store_name: "星辰二手车行",
          asking_amount: "13280000",
          currency: "CNY",
          currency_scale: 2,
          attributes: { category: "SUV" },
          match_reasons: ["价格符合预算", "品类为 SUV"],
        },
      ],
      uiActions: [],
    });
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);

    await user.type(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
      "预算 15 万以内的家用 SUV",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(await screen.findByText("价格符合预算")).toBeInTheDocument();
    expect(screen.getByText("品类为 SUV")).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "匹配理由" }),
    ).toBeInTheDocument();
  });

  it("opens a saved conversation from browser history", async () => {
    const historyKey = "matchplane.shopping-conversation-history.v1:root:buyer";
    window.localStorage.setItem(
      historyKey,
      JSON.stringify({
        owner: "user:user-1",
        conversations: [
          {
            id: "saved-conversation",
            title: "上周挑选通勤电脑",
            updatedAt: "2026-08-20T10:00:00.000Z",
            messages: [
              { id: "saved-user", role: "user", text: "上周的通勤电脑需求" },
              {
                id: "saved-assistant",
                role: "assistant",
                text: "这里是上周保存的建议",
              },
            ],
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<MatchChat home onNotice={vi.fn()} subplatform={subplatform} />);

    await user.click(await screen.findByRole("button", { name: "对话选项" }));
    await user.click(await screen.findByRole("menuitem", { name: "历史" }));
    expect(
      screen.getByRole("heading", { name: "历史对话" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^上周挑选通勤电脑/ }));

    expect(screen.getByText("上周的通勤电脑需求")).toBeInTheDocument();
    expect(screen.getByText("这里是上周保存的建议")).toBeInTheDocument();
  });

  it("does not expose a history action when that panel is unavailable", () => {
    const sellerView = render(
      <MatchChat onNotice={vi.fn()} role="seller" subplatform={subplatform} />,
    );

    expect(
      screen.queryByRole("button", { name: "历史" }),
    ).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("matchplane:open-shopping-history"));
    });
    expect(
      screen.queryByRole("dialog", { name: "历史对话" }),
    ).not.toBeInTheDocument();

    sellerView.unmount();
    render(
      <MatchChat
        onNotice={vi.fn()}
        subplatform={{ ...subplatform, slug: "tools", path: "/tools" }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "历史" }),
    ).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("matchplane:open-shopping-history"));
    });
    expect(
      screen.queryByRole("dialog", { name: "历史对话" }),
    ).not.toBeInTheDocument();
  });

  it("sends an open-ended question straight to the configured Agent", async () => {
    const user = userEvent.setup();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "你可以干什么");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      await screen.findByText("这是模型生成的导购回答。"),
    ).toBeInTheDocument();
    expect(askMallShoppingAssistant).toHaveBeenCalledWith([
      { role: "user", content: "你可以干什么" },
    ]);
    expect(
      screen.queryByText(/暂时没有找到合适的在售商品/),
    ).not.toBeInTheDocument();
  });

  it("renders an Agent question as selectable UI and sends the chosen value", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant
      .mockResolvedValueOnce({
        requestId: "33333333-3333-4333-8333-333333333333",
        answer: "先选一个更重要的方向。",
        recommendations: [],
        uiActions: [
          {
            type: "choice",
            id: "choice-1",
            question: "你更看重哪一点？",
            options: [
              { id: "option-1", label: "价格更低", value: "我更看重价格" },
              { id: "option-2", label: "质量更好", value: "我更看重质量" },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        requestId: "44444444-4444-4444-8444-444444444444",
        answer: "明白，我按价格优先继续找。",
        recommendations: [],
        uiActions: [],
      });
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "帮我挑一个");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    const option = await screen.findByRole("button", { name: "价格更低" });
    await user.click(option);

    await waitFor(() =>
      expect(askMallShoppingAssistant).toHaveBeenCalledTimes(2),
    );
    expect(askMallShoppingAssistant.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([{ role: "user", content: "我更看重价格" }]),
    );
    expect(option).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps history, memory, and conditional clear inside one composer menu", async () => {
    const user = userEvent.setup();
    render(
      <MatchChat
        compact
        home
        onNotice={vi.fn()}
        subplatform={{
          ...subplatform,
          ui: {
            ...subplatform.ui,
            chat: {
              ...subplatform.ui?.chat,
              homePlaceholderPhrases: ["自定义首页提示"],
            },
          },
        }}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    expect(input).toHaveAttribute("placeholder", "自定义首页提示");
    const options = await screen.findByRole("button", { name: "对话选项" });
    expect(options.closest("form")).toBe(input.closest("form"));
    await user.click(options);
    expect(await screen.findByRole("menuitem", { name: "历史" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "记忆" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "清空" }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.type(input, "给我一个真实建议");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    expect(await screen.findByText("这是模型生成的导购回答。")).toBeVisible();
    await user.click(options);
    expect(await screen.findByRole("menuitem", { name: "清空" })).toBeVisible();
  });

  it("lets the Agent decide how to handle a simple calculation", async () => {
    const user = userEvent.setup();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "1+1等于多少");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      await screen.findByText("这是模型生成的导购回答。"),
    ).toBeInTheDocument();
    expect(askMallShoppingAssistant).toHaveBeenCalledWith([
      { role: "user", content: "1+1等于多少" },
    ]);
  });

  it("routes store-scoped questions to the store AI and records staff handoff without ending chat", async () => {
    const user = userEvent.setup();
    const onHumanHandoff = vi.fn(async () => undefined);
    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "handoff-request-1",
      answer: "如需店员介入，请先确认通知。",
      recommendations: [],
      uiActions: [
        {
          type: "human_handoff",
          id: "human-handoff-1",
          summary: "客户手机号 138-1234-5678，请直接联系。",
          intent: "high",
          productIds: ["offer-1"],
        },
      ],
    });
    const store = {
      ...subplatform,
      slug: "test-store",
      path: "/test-store",
      label: "测试小店",
    };
    render(
      <MatchChat
        onNotice={vi.fn()}
        onHumanHandoff={onHumanHandoff}
        subplatform={store}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
      "我想购买，能让店员确认交付吗？",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      await screen.findByText("如需店员介入，请先确认通知。"),
    ).toBeVisible();
    expect(onHumanHandoff).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/138-1234-5678|请直接联系/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/只会共享结构化购买意向和已选商品编号/),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "确认并通知" }));

    await waitFor(() =>
      expect(onHumanHandoff).toHaveBeenCalledWith({
        requestId: "handoff-request-1",
        conversionAttemptId: expect.any(String),
        intent: "high",
        productIds: ["offer-1"],
      }),
    );
    expect(screen.getByText("人工介入请求已记录")).toBeVisible();
    expect(askMallShoppingAssistant).toHaveBeenCalledWith(expect.any(Array), {
      storePath: "/test-store",
    });
  });

  it("sends prior user and assistant turns as bounded context", async () => {
    const user = userEvent.setup();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "记住苹果，待会我要考你");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    await screen.findByText("这是模型生成的导购回答。");
    await user.type(input, "你刚刚记住了什么？");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    await waitFor(() =>
      expect(askMallShoppingAssistant).toHaveBeenCalledTimes(2),
    );
    expect(askMallShoppingAssistant.mock.calls[1]?.[0]).toEqual([
      { role: "user", content: "记住苹果，待会我要考你" },
      { role: "assistant", content: "这是模型生成的导购回答。" },
      { role: "user", content: "你刚刚记住了什么？" },
    ]);
  });
});
