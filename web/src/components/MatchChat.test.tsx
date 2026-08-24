import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MallAssistantUiAction, RecommendedBackendListing } from "../api";

type AssistantReplyFixture = {
  requestId: string;
  answer: string;
  recommendations: RecommendedBackendListing[];
  uiActions: MallAssistantUiAction[];
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

vi.mock("../lib/auth-client", () => ({
  authClient: { getSession },
  authFetchOptions: () => ({}),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isLiveMarketplaceEnabled: () => true,
  askMallShoppingAssistant,
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
  it("shows only the typing indicator until a result arrives", async () => {
    const user = userEvent.setup();
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
    render(<MatchChat home onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "寻找合适的方案");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      screen.getByRole("status", { name: "正在回复…" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("status", { name: "正在回复…" })[0],
    ).toHaveTextContent("");
    expect(screen.getByText("寻找合适的方案")).toBeInTheDocument();
    expect(screen.queryByText(/我先|AI 已|整理成一份/)).not.toBeInTheDocument();
    expect(
      document.querySelectorAll(
        ".chat-typing-indicator span[aria-hidden='true']",
      ),
    ).toHaveLength(3);

    expect(document.querySelector(".home-chat")).toHaveClass(
      "has-conversation",
    );
    expect(
      document
        .querySelector(".chat-typing-indicator")
        ?.closest(".home-chat-thread"),
    ).not.toBeNull();

    resolveRoute.current?.();
  });

  it("keeps a failed request retryable without turning the error into an assistant message", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant.mockRejectedValueOnce(
      new MarketplaceApiError(429, "请求过于频繁，请稍后再试。", {
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 90_000,
      }),
    );
    render(<MatchChat home onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });

    await user.type(input, "帮我找啊");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("请求过于频繁，请稍后再试。");
    expect(alert).toHaveTextContent("建议约 2 分钟后重试。");
    expect(input).toHaveValue("帮我找啊");
    expect(
      document.querySelectorAll(".match-chat-message.is-user"),
    ).toHaveLength(1);
    expect(
      document.querySelector(".match-chat-message.is-assistant"),
    ).toBeNull();

    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "44444444-4444-4444-8444-444444444444",
      answer: "可以。你具体想找什么？",
      recommendations: [],
      uiActions: [],
    });
    await user.click(screen.getByRole("button", { name: "再次发送" }));

    expect(
      await screen.findByText("可以。你具体想找什么？"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      document.querySelectorAll(".match-chat-message.is-user"),
    ).toHaveLength(1);
    expect(input).toHaveValue("");
    expect(askMallShoppingAssistant.mock.calls[1]?.[0]).toEqual([
      { role: "user", content: "帮我找啊" },
    ]);
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

  it("shows a public attachment photo inside the assistant answer", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant.mockResolvedValueOnce({
      requestId: "55555555-5555-4555-8555-555555555555",
      answer: "找到一件符合条件的商品。",
      recommendations: [
        {
          listing_id: "66666666-6666-4666-8666-666666666666",
          display_name: "照片可见的商品",
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
        },
      ],
      uiActions: [],
    });
    const onOpenListing = vi.fn();
    render(
      <MatchChat
        home
        onNotice={vi.fn()}
        onOpenListing={onOpenListing}
        subplatform={subplatform}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
      "给我看看照片",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    const image = await screen.findByRole("img", { name: "照片可见的商品" });
    expect(image).toHaveAttribute(
      "src",
      "https://images.example.test/product.jpg",
    );
    expect(image.closest(".match-chat-recommendations")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "照片可见的商品" }));
    expect(onOpenListing).toHaveBeenCalledWith(
      expect.objectContaining({ title: "照片可见的商品" }),
    );
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
