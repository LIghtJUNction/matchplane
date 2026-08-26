import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubplatformConfig } from "../subplatform";

const getSession = vi.hoisted(() =>
  vi.fn(async () => ({ data: { user: null } })),
);

vi.mock("../lib/auth-client", () => ({
  authClient: { getSession },
  authFetchOptions: () => ({}),
}));

vi.mock("../lib/marketplace-session", () => ({
  getMarketplaceSession: vi.fn(async () => null),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isLiveMarketplaceEnabled: () => true,
  askMallShoppingAssistant: vi.fn(async () => ({
    requestId: "11111111-1111-4111-8111-111111111111",
    answer: "已收到需求。",
    recommendations: [],
    uiActions: [],
  })),
}));

import { MatchChat } from "./MatchChat";

const rootPlatform = {
  slug: "root",
  path: "/",
  label: "MatchPlane",
  ui: {},
} as SubplatformConfig;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  getSession.mockClear();
});

describe("MatchChat root starters", () => {
  it("keeps three compact-capable buttons with useful names and real behavior", async () => {
    const user = userEvent.setup();
    render(
      <MatchChat
        home
        locale="zh"
        onNotice={vi.fn()}
        subplatform={rootPlatform}
      />,
    );

    const starter = screen.getByRole("button", {
      name: /描述真实需求.*说明预算、用途和不能妥协的条件/,
    });
    expect(
      screen.getByRole("button", {
        name: /比较已展示商品.*只依据已展示商品和事实说明取舍/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /查看公开店铺.*只列出当前公开店铺，不附加未经证实的认证声明/,
      }),
    ).toBeInTheDocument();

    starter.focus();
    expect(starter).toHaveFocus();
    await user.click(starter);
    expect(
      await screen.findByText("帮我梳理预算、用途和必须满足的条件。"),
    ).toBeInTheDocument();
  });
});
