import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformMenu } from "./PlatformMenu";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PlatformMenu", () => {
  it("shows active child platforms in a compact dropdown and closes with Escape", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        children: [
          { slug: "alpha", path: "/alpha", displayName: "Alpha", description: "Alpha platform" },
          { slug: "beta", path: "/beta", displayName: "Beta", description: "Beta platform" },
          { slug: "gamma", path: "/gamma", displayName: "Gamma", description: "Gamma platform" },
        ],
      }),
    } as Response);

    render(<PlatformMenu locale="zh" />);

    const trigger = await screen.findByRole("button", { name: "平台" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    expect(screen.getByRole("navigation", { name: "平台" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Alpha/ })).toHaveAttribute("href", "/alpha");
    expect(screen.getByRole("link", { name: /Beta/ })).toHaveAttribute("href", "/beta");
    expect(screen.getByRole("link", { name: /Gamma/ })).toHaveAttribute("href", "/gamma");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "平台" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("stays absent when the registry has no active child platforms", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ children: [] }),
    } as Response);

    render(<PlatformMenu locale="en" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Platforms" })).not.toBeInTheDocument();
  });
});
