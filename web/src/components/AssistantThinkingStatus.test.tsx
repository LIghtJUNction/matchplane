import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantThinkingStatus } from "./AssistantThinkingStatus";

function matchMedia(reducedMotion: boolean) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: reducedMotion,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener,
    removeEventListener,
    dispatchEvent: vi.fn(),
  });
  return { addEventListener, removeEventListener };
}

function legacyMatchMedia() {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AssistantThinkingStatus", () => {
  it.each([
    ["shopping", "正在检索公开店铺", "核对需求、商品与来源"],
    ["store", "正在准备回复", "结合当前店铺信息作答"],
    ["seller", "正在整理商品信息", "生成可检查的结构化内容"],
  ] as const)("keeps %s progress explicit in text", (mode, title, detail) => {
    const { container } = render(
      <AssistantThinkingStatus locale="zh" mode={mode} />,
    );

    expect(screen.getByRole("status", { name: "正在回复…" })).toHaveTextContent(
      `${title}${detail}`,
    );
    const visual = container.querySelector("[data-assistant-liquid]");
    expect(visual).toHaveAttribute("aria-hidden", "true");
    expect(visual).toHaveAttribute("data-activity", mode);
  });

  it("keeps the English working state localized", () => {
    render(<AssistantThinkingStatus locale="en" mode="shopping" />);

    expect(screen.getByRole("status", { name: "Replying…" })).toHaveTextContent(
      "Searching public storesChecking fit and source",
    );
  });

  it("server-renders a deterministic static status before enhancement", () => {
    const markup = renderToString(
      <AssistantThinkingStatus locale="en" mode="shopping" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-renderer="static"');
    expect(markup).not.toContain("data-gooey-svg");
  });

  it("loads the liquid enhancement without replacing the status semantics", async () => {
    matchMedia(false);
    const { container } = render(
      <AssistantThinkingStatus locale="en" mode="shopping" />,
    );

    const visual = container.querySelector("[data-assistant-liquid]");
    await waitFor(() =>
      expect(visual).toHaveAttribute("data-renderer", "liquid-gooey"),
    );
    expect(visual).toHaveAttribute("data-motion", "active");
    expect(container.querySelector("[data-gooey-svg]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByRole("status", { name: "Replying…" })).toBeVisible();
  });

  it("unmounts the liquid runtime while the status is offscreen", async () => {
    matchMedia(false);
    const disconnect = vi.fn();
    let reportVisibility = (_visible: boolean) => undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          reportVisibility = (visible) => {
            callback(
              [{ isIntersecting: visible } as IntersectionObserverEntry],
              {} as IntersectionObserver,
            );
          };
        }

        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = disconnect;
        takeRecords = () => [];
        root = null;
        rootMargin = "0px";
        thresholds = [0];
      },
    );

    const { container, unmount } = render(
      <AssistantThinkingStatus locale="en" mode="shopping" />,
    );
    const visual = container.querySelector("[data-assistant-liquid]");
    await waitFor(() =>
      expect(visual).toHaveAttribute("data-renderer", "liquid-gooey"),
    );

    act(() => reportVisibility(false));
    expect(visual).toHaveAttribute("data-renderer", "static");
    expect(container.querySelector("[data-gooey-svg]")).not.toBeInTheDocument();

    act(() => reportVisibility(true));
    expect(visual).toHaveAttribute("data-renderer", "liquid-gooey");

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("stays static when reduced motion is requested and removes listeners", async () => {
    const listeners = matchMedia(true);
    const { container, unmount } = render(
      <AssistantThinkingStatus locale="en" mode="store" />,
    );

    const visual = container.querySelector("[data-assistant-liquid]");
    await waitFor(() =>
      expect(listeners.addEventListener).toHaveBeenCalledWith(
        "change",
        expect.any(Function),
      ),
    );
    expect(visual).toHaveAttribute("data-renderer", "static");
    expect(visual).toHaveAttribute("data-motion", "paused");
    expect(container.querySelector("[data-gooey-svg]")).not.toBeInTheDocument();

    unmount();
    expect(listeners.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });

  it.each([
    "missing",
    "legacy",
  ] as const)("stays static when matchMedia is %s", async (support) => {
    if (support === "missing") {
      vi.stubGlobal("matchMedia", undefined);
    } else {
      legacyMatchMedia();
    }

    const { container } = render(
      <AssistantThinkingStatus locale="en" mode="shopping" />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const visual = container.querySelector("[data-assistant-liquid]");
    expect(visual).toHaveAttribute("data-renderer", "static");
    expect(visual).toHaveAttribute("data-motion", "paused");
    expect(container.querySelector("[data-gooey-svg]")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Replying…" })).toBeVisible();
  });

  it("stays static without MutationObserver", async () => {
    matchMedia(false);
    vi.stubGlobal("MutationObserver", undefined);
    const { container } = render(
      <AssistantThinkingStatus locale="zh" mode="shopping" />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const visual = container.querySelector("[data-assistant-liquid]");
    expect(visual).toHaveAttribute("data-renderer", "static");
    expect(container.querySelector("[data-gooey-svg]")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在回复…" })).toBeVisible();
  });

  it("fails closed when the liquid runtime throws after loading", async () => {
    matchMedia(false);
    const expectedError = new Error("ResizeObserver construction failed");
    const resizeObserverConstructed = vi.fn();
    class ThrowingResizeObserver {
      constructor() {
        resizeObserverConstructed();
        throw expectedError;
      }
    }
    vi.stubGlobal("ResizeObserver", ThrowingResizeObserver);

    const originalConsoleError = console.error;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      const expectedReactNoise = args.some(
        (argument) =>
          argument === expectedError ||
          (typeof argument === "string" &&
            argument.includes(expectedError.message)),
      );
      if (!expectedReactNoise) originalConsoleError(...args);
    });

    const { container } = render(
      <AssistantThinkingStatus locale="en" mode="seller" />,
    );
    await waitFor(() => expect(resizeObserverConstructed).toHaveBeenCalled());
    const visual = container.querySelector("[data-assistant-liquid]");
    await waitFor(() =>
      expect(visual).toHaveAttribute("data-renderer", "static"),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(resizeObserverConstructed).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-gooey-svg]")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Replying…" })).toBeVisible();
  });

  it("keeps a static fallback when the enhancement is unsupported", async () => {
    matchMedia(false);
    vi.stubGlobal("ResizeObserver", undefined);
    const { container } = render(
      <AssistantThinkingStatus locale="zh" mode="shopping" />,
    );

    const visual = container.querySelector("[data-assistant-liquid]");
    await waitFor(() =>
      expect(visual).toHaveAttribute("data-renderer", "static"),
    );
    expect(container.querySelector("[data-gooey-svg]")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在回复…" })).toBeVisible();
  });
});
