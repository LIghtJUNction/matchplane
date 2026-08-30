import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, waitFor, within } from "@testing-library/react";
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
  getStoresMock.mockReset();
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

  it("keeps four long bilingual stores compact, bounded, and keyboard navigable", async () => {
    const user = userEvent.setup();
    getStoresMock.mockResolvedValueOnce(
      Array.from({ length: 4 }, (_, index) => ({
        id: `store-${index + 1}`,
        slug: `store-${index + 1}`,
        path: `/store-${index + 1}`,
        displayName:
          index === 0
            ? "North China Independent Makers and Daily Objects 北方独立设计与日用器物店"
            : `Store ${index + 1}`,
        description:
          "A long English description with 中文说明 that must wrap without escaping its store boundary.",
        integrationKind: "hosted" as const,
        status: "active" as const,
      })),
    );

    render(<StorefrontDirectory locale="en" />);

    const list = await screen.findByRole("list", { name: "Stores" });
    expect(list).toHaveAttribute("data-store-count", "4");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getAllByRole("link")).toHaveLength(4);
    expect(within(list).getAllByText("Open")).toHaveLength(4);

    await user.tab();
    expect(within(list).getAllByRole("link")[0]).toHaveFocus();
  });

  it("reports successful API paths and clears them on cleanup", async () => {
    const onVisibleStorePathsChange = vi.fn();
    const { unmount } = render(
      <StorefrontDirectory
        locale="zh"
        onVisibleStorePathsChange={onVisibleStorePathsChange}
      />,
    );

    expect(onVisibleStorePathsChange).toHaveBeenCalledWith([]);
    await waitFor(() =>
      expect(onVisibleStorePathsChange).toHaveBeenLastCalledWith([
        "/useful-store",
      ]),
    );

    unmount();
    expect(onVisibleStorePathsChange).toHaveBeenLastCalledWith([]);
  });

  it.each([
    "empty",
    "failure",
  ] as const)("reports no API paths when the directory is %s", async (result) => {
    if (result === "empty") getStoresMock.mockResolvedValueOnce([]);
    else getStoresMock.mockRejectedValueOnce(new Error("directory failed"));
    const onVisibleStorePathsChange = vi.fn();
    render(
      <StorefrontDirectory
        locale="zh"
        onVisibleStorePathsChange={onVisibleStorePathsChange}
      />,
    );

    await waitFor(() => expect(getStoresMock).toHaveBeenCalledTimes(1));
    if (result === "failure") await screen.findByRole("alert");
    else await screen.findByText("暂时还没有营业中的店铺。");
    expect(onVisibleStorePathsChange).toHaveBeenLastCalledWith([]);
  });

  it("preserves the real describe-need action when it is supplied", async () => {
    const user = userEvent.setup();
    const onDescribeNeed = vi.fn();
    render(<StorefrontDirectory locale="zh" onDescribeNeed={onDescribeNeed} />);

    await user.click(await screen.findByRole("button", { name: "说需求" }));
    expect(onDescribeNeed).toHaveBeenCalledWith("/useful-store");
  });

  it("locks the root header and directory responsive interaction contract", () => {
    const css = readFileSync(
      join(process.cwd(), "src/retail-ui.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.app-shell:has\(\.root-marketplace-page\) \.brand-cluster \{\s*display: none;/,
    );
    expect(css).toMatch(
      /\.app-shell:has\(\.root-marketplace-page\) \.header-navigation \{\s*pointer-events: auto;/,
    );
    expect(css).not.toMatch(
      /\.app-shell:has\(\.root-marketplace-page\)[^{]*\.brand-cluster[^}]*visibility: visible;/,
    );
    expect(css).toMatch(
      /\.storefront-directory-grid\[data-store-count="1"\][^{]*\{[^}]*max-width: 32rem;[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
    );
    expect(css).toMatch(
      /\.storefront-directory-grid\[data-store-count="4"\][^{]*\{[^}]*max-width: 48rem;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /\.storefront-directory-link:focus-visible \{[^}]*outline: 3px solid var\(--retail-focus\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 40rem\)[\s\S]*?\.storefront-directory-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.storefront-directory-entry svg \{[^}]*transition: none;/,
    );
  });
});
