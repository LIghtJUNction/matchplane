import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PalettePicker } from "./PalettePicker";

describe("PalettePicker", () => {
  it("shows real role previews and announces the current palette", async () => {
    const user = userEvent.setup();
    const onPaletteChange = vi.fn();
    const { container, rerender } = render(
      <PalettePicker
        locale="zh"
        palette="ink"
        onPaletteChange={onPaletteChange}
      />,
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    expect(
      screen.getByRole("radio", { name: "墨色，当前配色" }),
    ).toBeChecked();
    expect(container.querySelectorAll(".palette-option-preview")).toHaveLength(
      5,
    );
    expect(
      container.querySelectorAll(
        ".palette-preview-surface, .palette-preview-background, .palette-preview-accent, .palette-preview-text",
      ),
    ).toHaveLength(20);

    await user.click(screen.getByRole("radio", { name: "苔绿" }));
    expect(onPaletteChange).toHaveBeenCalledWith("moss");

    rerender(
      <PalettePicker
        locale="zh"
        palette="moss"
        onPaletteChange={onPaletteChange}
      />,
    );
    expect(
      screen.getByRole("radio", { name: "苔绿，当前配色" }),
    ).toBeChecked();
  });

  it("keeps every palette option keyboard focusable", async () => {
    const user = userEvent.setup();
    render(
      <PalettePicker
        locale="en"
        palette="ink"
        onPaletteChange={vi.fn()}
      />,
    );

    await user.tab();
    expect(screen.getByRole("radio", { name: /Ink/ })).toHaveFocus();
  });
});
