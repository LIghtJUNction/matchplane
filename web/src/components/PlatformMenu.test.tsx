import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlatformMenu } from "./PlatformMenu";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PlatformMenu", () => {
  it("shows active stores in a compact dropdown and closes with Escape", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        stores: [
          {
            slug: "alpha",
            path: "/alpha",
            displayName: "Alpha",
            description: "Alpha platform",
          },
          {
            slug: "beta",
            path: "/beta",
            displayName: "Beta",
            description: "Beta platform",
          },
          {
            slug: "gamma",
            path: "/gamma",
            displayName: "Gamma",
            description: "Gamma platform",
          },
        ],
      }),
    } as Response);

    render(<PlatformMenu locale="zh" />);

    const trigger = await screen.findByRole("button", { name: "店铺" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveStyle({ minHeight: "44px", minWidth: "44px" });
    await user.click(trigger);

    expect(
      screen.getByRole("navigation", { name: "店铺" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Alpha/ })).toHaveAttribute(
      "href",
      "/alpha",
    );
    expect(screen.getByRole("link", { name: /Beta/ })).toHaveAttribute(
      "href",
      "/beta",
    );
    expect(screen.getByRole("link", { name: /Gamma/ })).toHaveAttribute(
      "href",
      "/gamma",
    );

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("navigation", { name: "店铺" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("stays absent when the directory has no active stores", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ stores: [] }),
    } as Response);

    render(<PlatformMenu locale="en" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Stores" }),
    ).not.toBeInTheDocument();
  });
});
