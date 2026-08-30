import { render, screen, waitFor } from "@testing-library/react";
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
});
