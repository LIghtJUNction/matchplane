import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SubplatformConfig } from "../subplatform";
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
    it("routes the publish-product control through the real publisher action", async () => {
        const user = userEvent.setup();
        const onPublishProduct = vi.fn();
        render(
            <MarketplaceHome
                catalogResolved
                listings={[]}
                locale="zh"
                theme="light"
                onLocaleChange={vi.fn()}
                onThemeChange={vi.fn()}
                onLikeListing={vi.fn(async () => undefined)}
                onNotice={vi.fn()}
                onOpenListing={vi.fn()}
                onPublishProduct={onPublishProduct}
                onRetryCatalog={vi.fn()}
                onRecommendations={vi.fn()}
                subplatform={
                    {
                        slug: "root",
                        path: "/",
                        label: "MatchPlane",
                        ui: {},
                    } as SubplatformConfig
                }
            />,
        );

        await user.click(
            screen.getAllByRole("button", { name: "发布商品" })[0],
        );
        expect(onPublishProduct).toHaveBeenCalledTimes(1);
    });

    it("keeps one clerk input and exposes it as a mobile bottom sheet", async () => {
        const user = userEvent.setup();
        const { container } = render(
            <MarketplaceHome
                catalogResolved
                listings={[listing]}
                locale="zh"
                theme="light"
                onLocaleChange={vi.fn()}
                onThemeChange={vi.fn()}
                onLikeListing={vi.fn(async () => undefined)}
                onNotice={vi.fn()}
                onOpenListing={vi.fn()}
                onPublishProduct={vi.fn()}
                onRetryCatalog={vi.fn()}
                onRecommendations={vi.fn()}
                subplatform={
                    {
                        slug: "root",
                        path: "/",
                        label: "MatchPlane",
                        ui: {},
                    } as SubplatformConfig
                }
            />,
        );

        expect(screen.getAllByRole("textbox")).toHaveLength(1);
        const toggle = screen.getByRole("button", { name: "问选货员" });
        expect(toggle).toHaveAttribute("aria-expanded", "false");

        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(container.querySelector(".root-marketplace-page")).toHaveClass(
            "is-clerk-open",
        );

        await user.click(
            screen.getAllByRole("button", { name: "关闭选货员" })[0],
        );
        expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("offers a real retry action when the catalog request fails", async () => {
        const user = userEvent.setup();
        const onRetryCatalog = vi.fn();
        render(
            <MarketplaceHome
                catalogResolved
                catalogError
                listings={[]}
                locale="zh"
                theme="light"
                onLocaleChange={vi.fn()}
                onThemeChange={vi.fn()}
                onLikeListing={vi.fn(async () => undefined)}
                onNotice={vi.fn()}
                onOpenListing={vi.fn()}
                onPublishProduct={vi.fn()}
                onRetryCatalog={onRetryCatalog}
                onRecommendations={vi.fn()}
                subplatform={
                    {
                        slug: "root",
                        path: "/",
                        label: "MatchPlane",
                        ui: {},
                    } as SubplatformConfig
                }
            />,
        );

        await user.click(screen.getByRole("button", { name: "重新读取商品" }));
        expect(onRetryCatalog).toHaveBeenCalledTimes(1);
    });
});
