import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getStores } from "../api";
import { StorefrontDirectory } from "./StorefrontDirectory";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, getStores: vi.fn() };
});

const getStoresMock = vi.mocked(getStores);

beforeEach(() => {
  getStoresMock.mockResolvedValue([
    {
      id: "store-1",
      slug: "useful-store",
      path: "/useful-store",
      displayName: "有用店铺",
      description: "真实营业店铺",
      integrationKind: "hosted",
      status: "active",
    },
  ]);
});

describe("StorefrontDirectory", () => {
  it("keeps one live store as a navigable editorial item", async () => {
    render(<StorefrontDirectory locale="zh" />);

    expect(
      screen.getByRole("heading", { name: "店铺", level: 2 }),
    ).toBeInTheDocument();
    const link = await screen.findByRole("link", {
      name: /有用店铺.*真实营业店铺.*进入店铺/,
    });
    expect(link).toHaveAttribute("href", "/useful-store");
    expect(link).toHaveClass("storefront-directory-link");
    expect(
      document.querySelectorAll(".storefront-directory-card"),
    ).toHaveLength(1);
    expect(screen.getByText("1 家在营业")).toBeInTheDocument();
  });

  it("preserves the real describe-need action when it is supplied", async () => {
    const user = userEvent.setup();
    const onDescribeNeed = vi.fn();
    render(<StorefrontDirectory locale="zh" onDescribeNeed={onDescribeNeed} />);

    await user.click(await screen.findByRole("button", { name: "说需求" }));
    expect(onDescribeNeed).toHaveBeenCalledWith("/useful-store");
  });
});
