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
                                listing={{
                                        ...listing,
                                        likeTotal: "15",
                                        viewerLikeCount: 5,
                                }}
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
                                listing={{
                                        ...listing,
                                        offerId: undefined,
                                        id: "demo-listing",
                                }}
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

        it("uses a keyboard-navigable toggle group for category filtering", async () => {
                const user = userEvent.setup();
                const homeListing: AssetListing = {
                        ...listing,
                        id: "home-listing",
                        title: "云朵羊毛毯",
                        facts: [
                                {
                                        key: "category",
                                        label: "分类",
                                        value: "家居",
                                },
                        ],
                };
                const digitalListing: AssetListing = {
                        ...listing,
                        id: "digital-listing",
                        title: "日光便携音箱",
                        facts: [
                                {
                                        key: "category",
                                        label: "分类",
                                        value: "数码",
                                },
                        ],
                };
                render(
                        <MarketplaceHome
                                catalogResolved
                                listings={[homeListing, digitalListing]}
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

                const categories = screen.getByRole("group", {
                        name: "商品分类",
                });
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

        it("keeps conversation off the root and routes the need to the listing platform", async () => {
                const user = userEvent.setup();
                const onDescribeNeed = vi.fn();
                render(
                        <MarketplaceHome
                                catalogResolved
                                listings={[
                                        {
                                                ...listing,
                                                platformPath: "/used-car",
                                        },
                                ]}
                                locale="zh"
                                onDescribeNeed={onDescribeNeed}
                                onLikeListing={vi.fn(async () => undefined)}
                                onOpenListing={vi.fn()}
                                onPublishProduct={vi.fn()}
                                onRetryCatalog={vi.fn()}
                        />,
                );

                expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
                await user.click(
                        screen.getByRole("button", { name: "说需求" }),
                );
                expect(onDescribeNeed).toHaveBeenCalledWith("/used-car");
        });

        it("keeps a visible demand entry when the catalog has no child path", async () => {
                const user = userEvent.setup();
                const onDescribeNeed = vi.fn();
                render(
                        <MarketplaceHome
                                catalogResolved
                                listings={[]}
                                locale="zh"
                                onDescribeNeed={onDescribeNeed}
                                onLikeListing={vi.fn(async () => undefined)}
                                onOpenListing={vi.fn()}
                                onPublishProduct={vi.fn()}
                                onRetryCatalog={vi.fn()}
                        />,
                );

                await user.click(
                        screen.getByRole("button", { name: "说需求" }),
                );
                expect(onDescribeNeed).toHaveBeenCalledWith(undefined);
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

                expect(screen.getByRole("alert")).toHaveAttribute(
                        "data-slot",
                        "alert",
                );
                await user.click(
                        screen.getByRole("button", { name: "重新读取商品" }),
                );
                expect(onRetryCatalog).toHaveBeenCalledTimes(1);
        });
});
