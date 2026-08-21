import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routePromise = vi.hoisted(() => ({ current: null as Promise<{ requestId: string; answer: string; recommendations: never[] }> | null }));
const resolveRoute = vi.hoisted(() => ({ current: null as (() => void) | null }));
const askMallShoppingAssistant = vi.hoisted(() => vi.fn(async () => ({
  requestId: "22222222-2222-4222-8222-222222222222",
  answer: "这是模型生成的导购回答。",
  recommendations: [],
})));

vi.mock("../lib/auth-client", () => ({
  authClient: { getSession: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
  authFetchOptions: () => ({}),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isLiveMarketplaceEnabled: () => true,
  askMallShoppingAssistant,
}));

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
  askMallShoppingAssistant.mockClear();
});

beforeEach(() => {
  askMallShoppingAssistant.mockResolvedValue({
    requestId: "22222222-2222-4222-8222-222222222222",
    answer: "这是模型生成的导购回答。",
    recommendations: [],
  });
});

describe("MatchChat sending state", () => {
  it("shows only the typing indicator until a result arrives", async () => {
    const user = userEvent.setup();
    askMallShoppingAssistant.mockImplementation(() => {
      routePromise.current = new Promise((resolve) => { resolveRoute.current = () => resolve({
        requestId: "22222222-2222-4222-8222-222222222222",
        answer: "这是模型生成的导购回答。",
        recommendations: [],
      }); });
      return routePromise.current;
    });
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" });

    await user.type(input, "寻找合适的方案");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(screen.getByRole("status", { name: "正在匹配…" })).toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "正在匹配…" })[0]).toHaveTextContent("");
    expect(screen.getByText("寻找合适的方案")).toBeInTheDocument();
    expect(screen.queryByText(/我先|AI 已|整理成一份/)).not.toBeInTheDocument();
    expect(document.querySelectorAll(".chat-typing-indicator span[aria-hidden='true']")).toHaveLength(3);

    resolveRoute.current?.();
  });

  it("sends an open-ended question straight to the configured Agent", async () => {
    const user = userEvent.setup();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" });

    await user.type(input, "你可以干什么");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(await screen.findByText("这是模型生成的导购回答。")).toBeInTheDocument();
    expect(askMallShoppingAssistant).toHaveBeenCalledWith("你可以干什么");
    expect(screen.queryByText(/暂时没有找到合适的在售商品/)).not.toBeInTheDocument();
  });

  it("lets the Agent decide how to handle a simple calculation", async () => {
    const user = userEvent.setup();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" });

    await user.type(input, "1+1等于多少");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(await screen.findByText("这是模型生成的导购回答。")).toBeInTheDocument();
    expect(askMallShoppingAssistant).toHaveBeenCalledWith("1+1等于多少");
  });
});
