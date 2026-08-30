import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AssetListing } from "../types";
import type { SubplatformConfig } from "../subplatform";
import { ListingSheet } from "./ListingSheet";

const listing: AssetListing = {
  id: "offer-1",
  platformPath: "/dogfood",
  subplatform: "dogfood",
  title: "Dogfood 测试商品",
  subtitle: "Dogfood 测试商店",
  price: "CNY 12.34",
  accent: "cactus",
  facts: [],
  offerId: "offer-1",
};

const subplatform: SubplatformConfig = {
  slug: "dogfood",
  path: "/dogfood",
  brandName: "Dogfood 测试商店",
  label: "Dogfood 测试商店",
  description: "端到端验证店铺",
};

describe("ListingSheet", () => {
  it("shows owner management instead of contact and supports a multi-image gallery", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    const ownedListing: AssetListing = {
      ...listing,
      imageUrl: "/first.webp",
      imageUrls: ["/first.webp", "/second.webp"],
    };
    render(
      <ListingSheet
        listing={ownedListing}
        subplatform={subplatform}
        locale="zh"
        onClose={vi.fn()}
        onContact={vi.fn()}
        onManage={onManage}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "申请联系" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("这是你管理的商品")).not.toBeInTheDocument();
    expect(screen.queryByText("店主模式")).not.toBeInTheDocument();
    expect(screen.getByAltText("Dogfood 测试商品 1/2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(screen.getByAltText("Dogfood 测试商品 2/2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理商品" }));
    expect(onManage).toHaveBeenCalledWith(ownedListing);
  });

  it("never presents provider hints as canonical match reasons", () => {
    const matchedListing: AssetListing = {
      ...listing,
      reasons: ["Verified canonical reason"],
      providerHints: ["Advisory provider hint"],
    };
    const view = render(
      <ListingSheet
        listing={matchedListing}
        subplatform={subplatform}
        locale="zh"
        onClose={vi.fn()}
        onContact={vi.fn()}
      />,
    );

    const canonicalSection = screen
      .getByRole("heading", { name: "匹配理由" })
      .closest("section");
    const providerSection = screen
      .getByRole("heading", { name: "店铺检索线索" })
      .closest("section");
    if (!canonicalSection || !providerSection) {
      throw new Error("Expected separate canonical and provider hint sections");
    }
    expect(
      within(canonicalSection).getByText("Verified canonical reason"),
    ).toBeInTheDocument();
    expect(
      within(canonicalSection).queryByText("Advisory provider hint"),
    ).toBeNull();
    expect(
      within(providerSection).getByText("Advisory provider hint"),
    ).toBeInTheDocument();

    view.rerender(
      <ListingSheet
        listing={matchedListing}
        subplatform={subplatform}
        locale="en"
        onClose={vi.fn()}
        onContact={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Store retrieval hints" }),
    ).toBeInTheDocument();
  });

  it("delegates Escape dismissal to the accessible drawer primitive", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ListingSheet
        listing={listing}
        subplatform={subplatform}
        locale="zh"
        onClose={onClose}
        onContact={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Dogfood 测试商品" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the detail open and confirms a completed contact request", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onContact = vi.fn(async () => undefined);
    render(
      <ListingSheet
        listing={listing}
        subplatform={subplatform}
        locale="zh"
        onClose={onClose}
        onContact={onContact}
      />,
    );

    await user.click(screen.getByRole("button", { name: "申请联系" }));

    expect(onContact).toHaveBeenCalledWith(listing);
    expect(
      await screen.findByRole("button", { name: "已发送" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "联系申请已发送，等待供给方同意",
    );
    expect(
      screen.getByRole("dialog", { name: "Dogfood 测试商品" }),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
