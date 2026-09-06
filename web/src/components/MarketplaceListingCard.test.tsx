import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssetListing } from "../types";
import { MarketplaceListingCard } from "./MarketplaceListingCard";

const listing: AssetListing = {
  id: "sample",
  offerId: "sample",
  title: "便携音箱",
  subtitle: "",
  price: "¥200",
  accent: "cactus",
  facts: [
    { label: "品类", value: "数码" },
    { label: "所在地", value: "杭州" },
  ],
  location: "杭州",
  storeName: "青禾店铺",
};

function card(item = listing) {
  return {
    listing: item,
    locale: "zh" as const,
    onOpen: vi.fn(),
    onLike: vi.fn(async () => {}),
  };
}

describe("marketplace product card", () => {
  it("shows a truthful missing-photo state without inventing product facts", () => {
    render(<MarketplaceListingCard {...card()} />);
    expect(screen.getByText("暂无图片")).toBeInTheDocument();
    expect(screen.getByText("杭州")).toHaveClass("marketplace-product-specs");
    expect(screen.queryByText("数码 · 杭州")).not.toBeInTheDocument();
    expect(screen.queryByText("杭州 · 杭州")).not.toBeInTheDocument();
  });

  it("uses the available image list and can recover when a failed URL changes", () => {
    const props = card({ ...listing, imageUrls: ["/first.jpg"] });
    const { rerender } = render(<MarketplaceListingCard {...props} />);
    const image = screen.getByRole("img", { name: listing.title });
    expect(image).toHaveAttribute("src", "/first.jpg");
    fireEvent.error(image);
    expect(screen.getByText("暂无图片")).toBeInTheDocument();
    rerender(
      <MarketplaceListingCard
        {...props}
        listing={{ ...listing, imageUrl: "/second.jpg" }}
      />,
    );
    expect(screen.getByRole("img", { name: listing.title })).toHaveAttribute(
      "src",
      "/second.jpg",
    );
    expect(screen.queryByText("暂无图片")).not.toBeInTheDocument();
  });

  it("keeps opening a product separate from liking it", async () => {
    const user = userEvent.setup();
    const props = card();
    render(<MarketplaceListingCard {...props} />);
    await user.click(screen.getByRole("button", { name: listing.title }));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /点赞/ }));
    expect(props.onLike).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });
});
