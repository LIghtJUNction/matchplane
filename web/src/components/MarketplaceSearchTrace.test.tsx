import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MallAssistantSearchTrace } from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import { MarketplaceSearchTrace } from "./MarketplaceSearchTrace";

const trace: MallAssistantSearchTrace = {
  source: "visible_recommendations",
  resultCount: 3,
  stores: [
    { path: "/camera", displayName: "影像店", offerCount: 2 },
    { path: "/audio", displayName: "音频店", offerCount: 1 },
  ],
};

function renderTrace(locale: InterfaceLocale = "zh") {
  const onOpenStore = vi.fn();
  return {
    onOpenStore,
    ...render(
      <MarketplaceSearchTrace
        trace={trace}
        locale={locale}
        onOpenStore={onOpenStore}
      />,
    ),
  };
}

describe("MarketplaceSearchTrace", () => {
  it.each([
    {
      locale: "zh" as const,
      heading: "这些结果来自哪里",
      summaryLabel: "检索来源概览",
      request: "你的需求",
      stores: "2 家店铺",
      result: "2 家店铺返回 3 个可见结果",
      expand: "查看检索路径",
    },
    {
      locale: "en" as const,
      heading: "Where these results came from",
      summaryLabel: "Search provenance summary",
      request: "Your request",
      stores: "2 stores",
      result: "3 visible matches from 2 stores",
      expand: "View search path",
    },
  ])(
    "shows the completed $locale provenance as a compact summary by default",
    ({ locale, heading, summaryLabel, request, stores, result, expand }) => {
      renderTrace(locale);

      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      const summary = screen.getByLabelText(summaryLabel);
      expect(within(summary).getByText(request)).toBeInTheDocument();
      expect(within(summary).getByText("MatchPlane")).toBeInTheDocument();
      expect(within(summary).getByText(stores)).toBeInTheDocument();
      expect(within(summary).getByText(result)).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: expand });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const details = document.getElementById(
        toggle.getAttribute("aria-controls") ?? "",
      );
      expect(details).toBeInTheDocument();
      expect(details).toHaveAttribute("hidden");
      expect(details?.querySelector(".marketplace-search-trace-store")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /影像店|camera/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("expands the honest store path, opens a source, and collapses it again", async () => {
    const user = userEvent.setup();
    const { onOpenStore } = renderTrace();
    const toggle = screen.getByRole("button", { name: "查看检索路径" });

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      document.getElementById(toggle.getAttribute("aria-controls") ?? ""),
    ).not.toHaveAttribute("hidden");
    const source = screen.getByRole("button", {
      name: "进入影像店，2 个可见结果",
    });
    await user.click(source);
    expect(onOpenStore).toHaveBeenCalledWith("/camera");

    await user.click(screen.getByRole("button", { name: "收起检索路径" }));
    expect(
      screen.getByRole("button", { name: "查看检索路径" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(source).not.toBeVisible();
    expect(
      screen.queryByRole("button", { name: "进入影像店，2 个可见结果" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a user-expanded trace stable across locale updates and resets for a new result", async () => {
    const user = userEvent.setup();
    const onOpenStore = vi.fn();
    const { rerender } = render(
      <MarketplaceSearchTrace
        trace={trace}
        locale="zh"
        onOpenStore={onOpenStore}
      />,
    );
    await user.click(screen.getByRole("button", { name: "查看检索路径" }));

    rerender(
      <MarketplaceSearchTrace
        trace={trace}
        locale="en"
        onOpenStore={onOpenStore}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Collapse search path" }),
    ).toHaveAttribute("aria-expanded", "true");

    const nextTrace: MallAssistantSearchTrace = {
      source: "visible_recommendations",
      resultCount: 1,
      stores: [{ path: "/books", displayName: "Book shop", offerCount: 1 }],
    };
    rerender(
      <MarketplaceSearchTrace
        trace={nextTrace}
        locale="en"
        onOpenStore={onOpenStore}
      />,
    );

    expect(
      screen.getByRole("button", { name: "View search path" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: /Book shop/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the disclosure bounded at narrow widths and disables its motion when requested", () => {
    const css = readFileSync(join(process.cwd(), "src/retail-ui.css"), "utf8");

    expect(css).toMatch(
      /\.marketplace-search-trace \{[^}]*width: min\(100%, 72rem\);[^}]*min-width: 0;/s,
    );
    expect(css).toMatch(
      /\.marketplace-search-trace-toggle \{[^}]*min-height: max\(2\.75rem, 44px\);[^}]*max-width: 100%;/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 48rem\)[\s\S]*\.marketplace-search-trace-heading \{[^}]*flex-wrap: wrap;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.marketplace-search-trace-toggle svg,[\s\S]*transition: none !important;/,
    );
  });
});
