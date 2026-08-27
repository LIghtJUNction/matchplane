import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubplatformConfig } from "../subplatform";
import { PasskeyPanel } from "./PasskeyPanel";

const subplatform: SubplatformConfig = {
  slug: "dogfood",
  path: "/dogfood",
  brandName: "Dogfood 测试商店",
  label: "Dogfood 测试商店",
  description: "端到端验证店铺",
};

describe("PasskeyPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps bind and remove actions on 44px targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "passkey-1",
              name: "Work laptop",
              createdAt: "2026-08-27T00:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(
      <PasskeyPanel
        locale="zh"
        subplatform={subplatform}
        onNotice={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "绑定当前设备" })).toHaveClass(
      "min-h-11",
    );
    expect(
      await screen.findByRole("button", { name: "移除 Work laptop" }),
    ).toHaveClass("min-h-11", "min-w-11");
  });
});
