import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MallAssistantSearchTrace,
  MallAssistantUiAction,
  RecommendedBackendListing,
} from "../api";
import { readChatDraft, type ChatDraftScope } from "../lib/chat-draft-session";

type AssistantReplyFixture = {
  requestId: string;
  answer: string;
  recommendations: RecommendedBackendListing[];
  uiActions: MallAssistantUiAction[];
  searchTrace?: MallAssistantSearchTrace;
  outcome?: "empty_catalog" | "no_matching_products";
};

const getSession = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ data: { user: { id: string } } | null }> => ({
      data: { user: { id: "user-1" } },
    }),
  ),
);
const askMallShoppingAssistant = vi.hoisted(() => vi.fn());
const createMarketplaceIntent = vi.hoisted(() => vi.fn());
const routePlatformIntent = vi.hoisted(() => vi.fn());
const upsertMarketplaceProfile = vi.hoisted(() => vi.fn());
const getMarketplaceSession = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth-client", () => ({
  authClient: { getSession },
  authFetchOptions: () => ({}),
}));

vi.mock("../lib/marketplace-session", () => ({
  getMarketplaceSession,
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isLiveMarketplaceEnabled: () => true,
  askMallShoppingAssistant,
  createMarketplaceIntent,
  routePlatformIntent,
  upsertMarketplaceProfile,
}));

import { MatchChat } from "./MatchChat";
import type { SubplatformConfig } from "../subplatform";

const subplatform = {
  slug: "root",
  path: "/",
  label: "MatchPlane",
  ui: {},
} as SubplatformConfig;
const pendingChatKey = "matchplane.pending-chat";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buyerDraftScope(route: string): ChatDraftScope {
  return { route, subplatform: "root", role: "buyer" };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  window.localStorage.clear();
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { user: { id: "user-1" } } });
  askMallShoppingAssistant.mockReset();
  askMallShoppingAssistant.mockResolvedValue({
    requestId: "22222222-2222-4222-8222-222222222222",
    answer: "这是模型生成的导购回答。",
    recommendations: [],
    uiActions: [],
  });
  getMarketplaceSession.mockReset();
  getMarketplaceSession.mockResolvedValue({
    tenantId: "11111111-1111-4111-8111-111111111111",
    partyId: "22222222-2222-4222-8222-222222222222",
    role: "seller",
    accessToken: "seller-session",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  routePlatformIntent.mockReset();
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
  createMarketplaceIntent.mockReset();
  createMarketplaceIntent.mockResolvedValue({
    intent_id: "44444444-4444-4444-8444-444444444444",
    version: 1,
  });
  upsertMarketplaceProfile.mockReset();
  upsertMarketplaceProfile.mockResolvedValue({});
});

describe("MatchChat unsent draft continuity", () => {
  it("restores a manual draft after a login-style round trip without submitting it", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=buyer");
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    const input = await screen.findByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    await user.type(input, "想找一件适合通勤的商品");
    expect(askMallShoppingAssistant).not.toHaveBeenCalled();

    first.unmount();
    window.history.replaceState(null, "", "/login?next=%2F%3Frole%3Dbuyer");
    window.history.replaceState(null, "", "/?role=buyer");
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);

    expect(
      await screen.findByRole("textbox", {
        name: "告诉 MatchPlane 你的需求",
      }),
    ).toHaveValue("想找一件适合通勤的商品");
    expect(askMallShoppingAssistant).not.toHaveBeenCalled();
  });

  it("clears the stored draft only after a successful send", async () => {
    const user = userEvent.setup();
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(
      await screen.findByRole("textbox", {
        name: "告诉 MatchPlane 你的需求",
      }),
      "需要防水通勤包",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    expect(
      await screen.findByText("这是模型生成的导购回答。"),
    ).toBeInTheDocument();

    first.unmount();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(
      await screen.findByRole("textbox", {
        name: "告诉 MatchPlane 你的需求",
      }),
    ).toHaveValue("");
  });

  it("retains the submitted text when sending fails", async () => {
    askMallShoppingAssistant.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(
      await screen.findByRole("textbox", {
        name: "告诉 MatchPlane 你的需求",
      }),
      "失败后仍需保留",
    );
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");

    first.unmount();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(
      await screen.findByRole("textbox", {
        name: "告诉 MatchPlane 你的需求",
      }),
    ).toHaveValue("失败后仍需保留");
  });

  it("clears only route A when its deferred send succeeds after route B has a draft", async () => {
    const request = deferred<AssistantReplyFixture>();
    askMallShoppingAssistant.mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    const routeA = buyerDraftScope("/route-a");
    const routeB = buyerDraftScope("/route-b");

    window.history.replaceState(null, "", routeA.route);
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "A 的待处理需求");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    await waitFor(() => expect(askMallShoppingAssistant).toHaveBeenCalled());
    first.unmount();

    window.history.replaceState(null, "", routeB.route);
    const second = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "B 的未发送草稿");

    await act(async () => {
      request.resolve({
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        answer: "A 已完成",
        recommendations: [],
        uiActions: [],
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(readChatDraft(window.sessionStorage, routeA)).toBeNull(),
    );
    expect(readChatDraft(window.sessionStorage, routeB)).toBe("B 的未发送草稿");
    expect(screen.getByRole("textbox")).toHaveValue("B 的未发送草稿");

    second.unmount();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(await screen.findByRole("textbox")).toHaveValue("B 的未发送草稿");
  });

  it("restores only route A when its deferred send fails after route B has a draft", async () => {
    const request = deferred<AssistantReplyFixture>();
    askMallShoppingAssistant.mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    const routeA = buyerDraftScope("/route-a");
    const routeB = buyerDraftScope("/route-b");

    window.history.replaceState(null, "", routeA.route);
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "A 失败后应保留");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    await waitFor(() => expect(askMallShoppingAssistant).toHaveBeenCalled());
    first.unmount();

    window.history.replaceState(null, "", routeB.route);
    const second = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "B 仍然独立");

    await act(async () => {
      request.reject(new Error("offline"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(readChatDraft(window.sessionStorage, routeA)).toBe(
        "A 失败后应保留",
      ),
    );
    expect(readChatDraft(window.sessionStorage, routeB)).toBe("B 仍然独立");
    expect(screen.getByRole("textbox")).toHaveValue("B 仍然独立");

    second.unmount();
    window.history.replaceState(null, "", routeA.route);
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(await screen.findByRole("textbox")).toHaveValue("A 失败后应保留");
  });

  it("isolates restored text by route, subplatform, and role", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/catalog?role=buyer");
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "只属于根商城买家");
    first.unmount();

    const seller = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} role="seller" />,
    );
    expect(await screen.findByRole("textbox")).toHaveValue("");
    seller.unmount();

    const child = render(
      <MatchChat
        onNotice={vi.fn()}
        subplatform={{ ...subplatform, slug: "matx", path: "/stores/matx" }}
      />,
    );
    expect(await screen.findByRole("textbox")).toHaveValue("");
    child.unmount();

    window.history.replaceState(null, "", "/different?role=buyer");
    const otherRoute = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    expect(await screen.findByRole("textbox")).toHaveValue("");
    otherRoute.unmount();

    window.history.replaceState(null, "", "/catalog?role=buyer");
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(await screen.findByRole("textbox")).toHaveValue("只属于根商城买家");
  });

  it("removes a draft when the user explicitly clears the textarea", async () => {
    const user = userEvent.setup();
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    const input = await screen.findByRole("textbox");
    await user.type(input, "主动清空的草稿");
    await user.clear(input);

    first.unmount();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(await screen.findByRole("textbox")).toHaveValue("");
  });

  it("removes a draft when a new conversation is explicitly requested", async () => {
    const user = userEvent.setup();
    const first = render(
      <MatchChat onNotice={vi.fn()} subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "准备清除的草稿");

    act(() => {
      window.dispatchEvent(new Event("matchplane:new-shopping-conversation"));
    });
    expect(screen.getByRole("textbox")).toHaveValue("");

    first.unmount();
    render(<MatchChat onNotice={vi.fn()} subplatform={subplatform} />);
    expect(await screen.findByRole("textbox")).toHaveValue("");
  });

  it("keeps an unauthenticated seller handoff draft until the pending submit succeeds", async () => {
    const user = userEvent.setup();
    const sellerSubplatform = {
      slug: "tools",
      path: "/tools",
      label: "工具平台",
      tenantId: "11111111-1111-4111-8111-111111111111",
      domainId: "55555555-5555-4555-8555-555555555555",
      pricing: { mode: "none" },
      marketplaceContract: "generic-v1",
      ui: {},
    } as SubplatformConfig;
    const sellerScope: ChatDraftScope = {
      route: "/seller-entry",
      subplatform: sellerSubplatform.slug,
      role: "seller",
    };
    window.history.replaceState(null, "", sellerScope.route);
    getMarketplaceSession.mockResolvedValue(null);
    const first = render(
      <MatchChat
        onNotice={vi.fn()}
        role="seller"
        subplatform={sellerSubplatform}
      />,
    );
    await user.type(await screen.findByRole("textbox"), "登录后继续发布供给");
    await user.click(screen.getByRole("button", { name: "发送供给" }));

    await waitFor(() =>
      expect(window.sessionStorage.getItem(pendingChatKey)).not.toBeNull(),
    );
    expect(readChatDraft(window.sessionStorage, sellerScope)).toBe(
      "登录后继续发布供给",
    );
    first.unmount();

    getMarketplaceSession.mockResolvedValue({
      tenantId: sellerSubplatform.tenantId,
      partyId: "22222222-2222-4222-8222-222222222222",
      role: "seller",
      accessToken: "seller-session",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const authenticated = render(
      <MatchChat
        onNotice={vi.fn()}
        role="seller"
        subplatform={sellerSubplatform}
      />,
    );
    expect(
      await screen.findByText(
        "供给描述已整理；请在下方提交资料，提交后才会写入系统",
      ),
    ).toBeInTheDocument();
    expect(createMarketplaceIntent).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(pendingChatKey)).toBeNull();
    expect(readChatDraft(window.sessionStorage, sellerScope)).toBeNull();

    authenticated.unmount();
    render(
      <MatchChat
        onNotice={vi.fn()}
        role="seller"
        subplatform={sellerSubplatform}
      />,
    );
    expect(await screen.findByRole("textbox")).toHaveValue("");
  });

  it("restores a merely unsent seller draft without auto-submitting it", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/seller-manual");
    const first = render(
      <MatchChat onNotice={vi.fn()} role="seller" subplatform={subplatform} />,
    );
    await user.type(await screen.findByRole("textbox"), "只保存，不提交");
    first.unmount();

    render(
      <MatchChat onNotice={vi.fn()} role="seller" subplatform={subplatform} />,
    );
    expect(await screen.findByRole("textbox")).toHaveValue("只保存，不提交");
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(window.sessionStorage.getItem(pendingChatKey)).toBeNull();
    expect(routePlatformIntent).not.toHaveBeenCalled();
    expect(createMarketplaceIntent).not.toHaveBeenCalled();
  });
});
