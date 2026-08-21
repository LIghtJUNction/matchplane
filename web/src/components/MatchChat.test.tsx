import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const routePromise = vi.hoisted(() => ({ current: null as Promise<unknown> | null }));
const resolveRoute = vi.hoisted(() => ({ current: null as (() => void) | null }));
const searchMallCatalog = vi.hoisted(() => vi.fn(() => {
  routePromise.current = new Promise((resolve) => { resolveRoute.current = () => resolve({
    requestId: "11111111-1111-4111-8111-111111111111",
    stores: [],
    recommendations: [],
    routing: { source: "policy_fallback", degraded: false, rationale: "none" },
  }); });
  return routePromise.current;
}));
const askMallShoppingAssistant = vi.hoisted(() => vi.fn(async () => ({
  requestId: "22222222-2222-4222-8222-222222222222",
  answer: "这是模型生成的导购回答。",
})));

vi.mock("../lib/auth-client", () => ({
  authClient: { getSession: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
  authFetchOptions: () => ({}),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isLiveMarketplaceEnabled: () => true,
  searchMallCatalog,
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
  searchMallCatalog.mockClear();
  askMallShoppingAssistant.mockClear();
});

describe("MatchChat sending state", () => {
  it("shows only the typing indicator until a result arrives", async () => {
    const user = userEvent.setup();
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

  it("answers a capability question without pretending it is an empty product search", async () => {
    const user = userEvent.setup();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    const input = screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" });

    await user.type(input, "你可以干什么");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(await screen.findByText("这是模型生成的导购回答。")).toBeInTheDocument();
    expect(searchMallCatalog).not.toHaveBeenCalled();
    expect(askMallShoppingAssistant).toHaveBeenCalledWith("你可以干什么", "capability");
    expect(screen.queryByText(/暂时没有找到合适的在售商品/)).not.toBeInTheDocument();
  });
});
