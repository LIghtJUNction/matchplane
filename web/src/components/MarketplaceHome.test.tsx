import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AssetListing } from "../types";
import { MarketplaceHome } from "./MarketplaceHome";
import { MarketplaceListingCard } from "./MarketplaceListingCard";

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
  render(
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
      onOpenStore={onOpenStore}
      onLikeListing={vi.fn(async () => undefined)}
      onOpenListing={vi.fn()}
      onRetryCatalog={vi.fn()}
      {...overrides}
    />,
  );
  return { onOpenStore };
}

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

    expect(
      screen.getByRole("heading", { name: "说说你想找什么。", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "购物需求" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("这些结果来自哪里")).not.toBeInTheDocument();
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
      screen.getByRole("button", {
        name: "Open Example Store, 1 visible match",
      }),
    ).toBeInTheDocument();
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

  it("offers a real retry action when the catalog request fails", async () => {
    const user = userEvent.setup();
    const onRetryCatalog = vi.fn();
    renderHome({ catalogError: true, onRetryCatalog });

    expect(screen.getByRole("alert")).toHaveAttribute("data-slot", "alert");
    await user.click(screen.getByRole("button", { name: "重新读取商品" }));
    expect(onRetryCatalog).toHaveBeenCalledTimes(1);
  });
});
