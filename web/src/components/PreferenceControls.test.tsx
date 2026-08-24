import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PreferenceControls } from "./PreferenceControls";

describe("PreferenceControls", () => {
  it("keeps palette, theme, text size, and locale in one compact popover", async () => {
    const user = userEvent.setup();
    const onPaletteChange = vi.fn();
    const onTextSizeChange = vi.fn();
    render(
      <PreferenceControls
        theme="light"
        locale="zh"
        palette="ink"
        textSize="default"
        onThemeChange={vi.fn()}
        onLocaleChange={vi.fn()}
        onPaletteChange={onPaletteChange}
        onTextSizeChange={onTextSizeChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "显示与语言" });
    await user.click(trigger);

    expect(screen.getByText("调整配色、明暗、文字大小和语言。")).toBeVisible();
    expect(screen.getByRole("radio", { name: "墨色，当前配色" })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "默认文字大小" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("radio", { name: "梅紫" }));
    await user.click(screen.getByRole("button", { name: "较大文字" }));
    expect(onPaletteChange).toHaveBeenCalledWith("plum");
    expect(onTextSizeChange).toHaveBeenCalledWith("large");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "苔绿" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });
});
