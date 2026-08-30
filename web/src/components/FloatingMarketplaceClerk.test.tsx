import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({ desktop: true }));

vi.mock("@appica/ui-react/hooks/use-media-query", () => ({
  useMediaQuery: () => media.desktop,
}));

import { FloatingMarketplaceClerk } from "./FloatingMarketplaceClerk";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <FloatingMarketplaceClerk locale="zh" open={open} onOpenChange={setOpen}>
      <label>
        需求
        <textarea />
      </label>
    </FloatingMarketplaceClerk>
  );
}

describe("FloatingMarketplaceClerk", () => {
  beforeEach(() => {
    media.desktop = true;
  });

  it("uses a bounded desktop dialog without drag, resize, or stow controls", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "打开找商品" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    expect(await screen.findByRole("dialog", { name: "找商品" })).toHaveClass(
      "desktop-clerk-dialog",
    );
    expect(screen.getByRole("textbox", { name: "需求" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /收纳|展开|缩放|拖动/ }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "找商品" }),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("uses the Appica drawer below the desktop breakpoint", async () => {
    media.desktop = false;
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开找商品" }));
    const dialog = await screen.findByRole("dialog", { name: "找商品" });
    expect(dialog).toHaveClass("mobile-clerk-drawer");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});
