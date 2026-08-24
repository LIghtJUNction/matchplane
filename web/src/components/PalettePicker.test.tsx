import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { InterfacePalette } from "../lib/preferences";
import { PalettePicker } from "./PalettePicker";

function PaletteHarness({
  onChange = () => undefined,
}: {
  onChange?: (palette: InterfacePalette) => void;
}) {
  const [palette, setPalette] = useState<InterfacePalette>("ink");
  return (
    <PalettePicker
      locale="zh"
      palette={palette}
      onPaletteChange={(next) => {
        setPalette(next);
        onChange(next);
      }}
    />
  );
}

describe("PalettePicker", () => {
  it("renders five multi-color radio cards and supports arrow-key selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PaletteHarness onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: "选择配色：墨色" });
    await user.click(trigger);

    const group = screen.getByRole("radiogroup", { name: "配色方案" });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    expect(screen.getByRole("radio", { name: "墨色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen
        .getByRole("radio", { name: "墨色" })
        .closest(".palette-radio-card")
        ?.querySelectorAll(".palette-radio-preview > span") ?? [],
    ).toHaveLength(4);

    await user.click(screen.getByRole("radio", { name: "墨色" }));
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "苔绿" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(onChange).toHaveBeenCalledWith("moss");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(group).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
