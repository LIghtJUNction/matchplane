import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStores } from "../api";
import type { AssetListing } from "../types";
import {
  MARKETPLACE_WEBMCP_METADATA,
  type WebMcpModelContext,
  type WebMcpTool,
} from "../webmcp/marketplace-tools";
import { MarketplaceHome } from "./MarketplaceHome";
import { MarketplaceListingCard } from "./MarketplaceListingCard";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, getStores: vi.fn() };
});

const getStoresMock = vi.mocked(getStores);

const directoryStore = {
  id: "store-1",
  slug: "useful-store",
  path: "/useful-store",
  displayName: "有用店铺",
  description: "真实营业店铺",
  integrationKind: "hosted" as const,
  status: "active" as const,
};

const listing: AssetListing = {
  id: "11111111-1111-7111-8111-111111111111",
  offerId: "11111111-1111-7111-8111-111111111111",
  title: "测试商品",
  subtitle: "测试店铺",
  storeName: "测试店铺",
  price: "CNY 100",
  accent: "cactus",
  facts: [],
  likeTotal: "12",
  viewerLikeCount: 2,
};

function renderHome(
  overrides: Partial<React.ComponentProps<typeof MarketplaceHome>> = {},
) {
  const onOpenStore = vi.fn();
  const onOpenListing = vi.fn();
  const view = render(
    <MarketplaceHome
      catalogResolved
      listings={[]}
      locale="zh"
      assistant={
        <label>
          购物需求
          <textarea />
        </label>
      }
      onWebMcpDescribeNeed={vi.fn()}
      onOpenStore={onOpenStore}
      onLikeListing={vi.fn(async () => undefined)}
      onOpenListing={onOpenListing}
      onRetryCatalog={vi.fn()}
      {...overrides}
    />,
  );
  return { ...view, onOpenListing, onOpenStore };
}

function installWebMcp() {
  vi.stubGlobal("isSecureContext", true);
  const registrations: Array<{ tool: WebMcpTool; signal: AbortSignal }> = [];
  const modelContext: WebMcpModelContext = {
    registerTool: vi.fn(async (tool, options) => {
      registrations.push({ tool, signal: options.signal });
    }),
  };
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: modelContext,
  });
  return registrations;
}

function activeWebMcpTools(
  registrations: Array<{ tool: WebMcpTool; signal: AbortSignal }>,
) {
  return registrations.filter(({ signal }) => !signal.aborted);
}

function activeWebMcpTool(
  registrations: Array<{ tool: WebMcpTool; signal: AbortSignal }>,
  name: string,
) {
  const registration = activeWebMcpTools(registrations).find(
    ({ tool }) => tool.name === name,
  );
  if (!registration) throw new Error(`missing active WebMCP tool: ${name}`);
  return registration.tool;
}

beforeEach(() => {
  getStoresMock.mockReset();
  getStoresMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "modelContext");
});

describe("MarketplaceListingCard likes", () => {
  it("shows the total and lets the viewer add another like", async () => {
    const user = userEvent.setup();
    const onLike = vi.fn(async () => undefined);
    render(
      <MarketplaceListingCard
        listing={listing}
        locale="zh"
        onOpen={vi.fn()}
        onLike={onLike}
      />,
    );

    const button = screen.getByRole("button", {
      name: "给测试商品点赞：已点 2/5，共 12 个赞",
    });
    expect(button).toHaveTextContent("12");
    await user.click(button);
    expect(onLike).toHaveBeenCalledTimes(1);
  });

  it("stops at five likes for one account", () => {
    render(
      <MarketplaceListingCard
        listing={{ ...listing, likeTotal: "15", viewerLikeCount: 5 }}
        locale="zh"
        onOpen={vi.fn()}
        onLike={vi.fn(async () => undefined)}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "测试商品：已点 5 个赞，达到上限，共 15 个赞",
      }),
    ).toBeDisabled();
  });

  it("does not render a like control when liking is unavailable", () => {
    render(
      <MarketplaceListingCard
        listing={{ ...listing, offerId: undefined, id: "demo-listing" }}
        locale="zh"
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /点赞/ }),
    ).not.toBeInTheDocument();
  });

  it("shows at most three canonical match reasons on compact result cards", () => {
    render(
      <MarketplaceListingCard
        compact
        listing={{
          ...listing,
          reasons: [
            "价格符合预算",
            "品类为 SUV",
            "杭州现车",
            "这一条不应显示",
            "价格符合预算",
          ],
        }}
        locale="zh"
        onOpen={vi.fn()}
      />,
    );

    const reasons = screen.getByRole("list", { name: "匹配理由" });
    expect(reasons).toHaveTextContent("价格符合预算");
    expect(reasons).toHaveTextContent("品类为 SUV");
    expect(reasons).toHaveTextContent("杭州现车");
    expect(reasons).not.toHaveTextContent("这一条不应显示");
    expect(within(reasons).getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("MarketplaceHome actions", () => {
  it.each([
    ["zh", []],
    ["en", []],
    ["zh", [listing]],
    ["en", [listing]],
  ] as const)("does not expose root publishing for %s with catalog %s", (locale, listings) => {
    renderHome({
      locale,
      listings: listings as unknown as AssetListing[],
    });

    expect(
      screen.queryByRole("button", { name: "发布商品" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "List a product" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the inline shopping prompt as the root primary task", () => {
    renderHome();

    expect(screen.getByText("MatchPlane")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "说说你想找什么。", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "购物需求" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("这些结果来自哪里")).not.toBeInTheDocument();
  });

  it("surfaces the configured marketplace brand above the chat task", () => {
    renderHome({ brandName: "青禾商城" });

    expect(screen.getByText("青禾商城")).toBeInTheDocument();
    expect(
      screen.getByText(/青禾商城 会检索公开店铺/),
    ).toBeInTheDocument();
  });

  it.each([
    [[]],
    [[listing]],
  ])("keeps products and stores in one editorial flow", (listings) => {
    renderHome({ listings });

    const content = document.querySelector(".root-marketplace-content");
    expect(content).not.toBeNull();
    expect(content).not.toHaveClass("is-sparse");
    expect(content?.children).toHaveLength(2);
  });

  it("keeps the truthful empty product status ahead of the store directory", () => {
    renderHome();

    expect(screen.getByText("暂时还没有通过审核的商品")).toBeInTheDocument();
    expect(
      screen.getByText("可以修改上方需求，也可以浏览下方已营业店铺。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "店铺", level: 2 }),
    ).toBeInTheDocument();
  });

  it("renders only the current real result stores and opens the selected store", async () => {
    const user = userEvent.setup();
    const { onOpenStore } = renderHome({
      searchTrace: {
        source: "visible_recommendations",
        resultCount: 3,
        stores: [
          { path: "/store-a", displayName: "示例店铺甲", offerCount: 2 },
          { path: "/store-b", displayName: "示例店铺乙", offerCount: 1 },
        ],
      },
    });

    expect(
      screen.getByRole("heading", { name: "这些结果来自哪里" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 家店铺返回 3 个可见结果")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看检索路径" }));
    await user.click(
      screen.getByRole("button", {
        name: "进入示例店铺甲，2 个可见结果",
      }),
    );
    expect(onOpenStore).toHaveBeenCalledWith("/store-a");
  });

  it("formats a singular English result source without changing its path", () => {
    renderHome({
      locale: "en",
      searchTrace: {
        source: "visible_recommendations",
        resultCount: 1,
        stores: [
          { path: "/store-a", displayName: "Example Store", offerCount: 1 },
        ],
      },
    });

    expect(
      screen.getByText("1 visible match from 1 store"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View search path" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", {
        name: "Open Example Store, 1 visible match",
      }),
    ).not.toBeInTheDocument();
  });

  it("uses a keyboard-navigable toggle group for category filtering", async () => {
    const user = userEvent.setup();
    const homeListing: AssetListing = {
      ...listing,
      id: "home-listing",
      title: "云朵羊毛毯",
      facts: [{ key: "category", label: "分类", value: "家居" }],
    };
    const digitalListing: AssetListing = {
      ...listing,
      id: "digital-listing",
      title: "日光便携音箱",
      facts: [{ key: "category", label: "分类", value: "数码" }],
    };
    renderHome({ listings: [homeListing, digitalListing] });

    const categories = screen.getByRole("group", { name: "商品分类" });
    const all = screen.getByRole("button", { name: "全部" });
    const home = screen.getByRole("button", { name: "家居" });
    expect(categories).toContainElement(all);
    expect(all).toHaveAttribute("aria-pressed", "true");

    all.focus();
    await user.keyboard("{ArrowRight}");
    expect(home).toHaveFocus();
    await user.keyboard(" ");

    expect(home).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "云朵羊毛毯" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "日光便携音箱" }),
    ).not.toBeInTheDocument();
  });

  it("adds the loaded directory store to WebMCP and aborts prior registrations", async () => {
    getStoresMock.mockResolvedValueOnce([directoryStore]);
    const registrations = installWebMcp();
    const { onOpenStore, unmount } = renderHome();
    const initialSignal = registrations[0]?.signal;

    await waitFor(() =>
      expect(
        activeWebMcpTools(registrations).map(({ tool }) => tool.name),
      ).toContain(MARKETPLACE_WEBMCP_METADATA.openStore.name),
    );
    expect(initialSignal?.aborted).toBe(true);

    await act(async () => {
      await activeWebMcpTool(
        registrations,
        MARKETPLACE_WEBMCP_METADATA.openStore.name,
      ).execute({ platform_path: directoryStore.path });
    });
    expect(onOpenStore).toHaveBeenCalledWith(directoryStore.path);

    const activeSignal = activeWebMcpTools(registrations)[0]?.signal;
    unmount();
    expect(activeSignal?.aborted).toBe(true);
  });

  it.each([
    "empty",
    "failure",
  ] as const)("does not expose an open-store tool when the directory is %s", async (result) => {
    if (result === "failure") {
      getStoresMock.mockRejectedValueOnce(new Error("directory failed"));
    }
    const registrations = installWebMcp();
    renderHome();

    await waitFor(() => expect(getStoresMock).toHaveBeenCalledTimes(1));
    if (result === "failure") {
      await screen.findByRole("alert");
    } else {
      await screen.findByText("暂时还没有营业中的店铺。");
    }
    expect(
      activeWebMcpTools(registrations).map(({ tool }) => tool.name),
    ).not.toContain(MARKETPLACE_WEBMCP_METADATA.openStore.name);
  });

  it("refuses a category-hidden listing while opening the filtered visible listing", async () => {
    const user = userEvent.setup();
    const registrations = installWebMcp();
    const homeListing: AssetListing = {
      ...listing,
      id: "home-listing",
      title: "云朵羊毛毯",
      facts: [{ key: "category", label: "分类", value: "家居" }],
    };
    const digitalListing: AssetListing = {
      ...listing,
      id: "digital-listing",
      title: "日光便携音箱",
      facts: [{ key: "category", label: "分类", value: "数码" }],
    };
    const { onOpenListing } = renderHome({
      listings: [homeListing, digitalListing],
    });

    await waitFor(() =>
      expect(
        activeWebMcpTools(registrations).map(({ tool }) => tool.name),
      ).toContain(MARKETPLACE_WEBMCP_METADATA.openListing.name),
    );
    await user.click(screen.getByRole("button", { name: "家居" }));
    const openListing = activeWebMcpTool(
      registrations,
      MARKETPLACE_WEBMCP_METADATA.openListing.name,
    );

    await expect(
      openListing.execute({ listing_id: digitalListing.id }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "not_visible" },
    });
    await expect(
      openListing.execute({ listing_id: homeListing.id }),
    ).resolves.toEqual({
      ok: true,
      action: "listing_opened",
      listing_id: homeListing.id,
    });
    expect(onOpenListing).toHaveBeenCalledTimes(1);
    expect(onOpenListing).toHaveBeenCalledWith(homeListing);
  });

  it("offers a real retry action when the catalog request fails", async () => {
    const user = userEvent.setup();
    const onRetryCatalog = vi.fn();
    renderHome({ catalogError: true, onRetryCatalog });

    expect(screen.getByRole("alert")).toHaveAttribute("data-slot", "alert");
    await user.click(screen.getByRole("button", { name: "重新读取商品" }));
    expect(onRetryCatalog).toHaveBeenCalledTimes(1);
  });
});
