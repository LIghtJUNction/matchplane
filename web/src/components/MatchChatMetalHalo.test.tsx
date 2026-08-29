import { act, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metalMock = vi.hoisted(() => ({
  moduleLoaded: vi.fn(),
  rendered: vi.fn(),
  shouldThrow: false,
}));

vi.mock("metal-fx", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  metalMock.moduleLoaded();

  return {
    MetalFx({ children, theme }: { children?: ReactNode; theme?: string }) {
      metalMock.rendered(theme);
      if (metalMock.shouldThrow) {
        throw new Error("mock MetalFx render failure");
      }
      return React.createElement(
        "div",
        { "data-mocked-metal-fx": "", "data-metal-theme": theme },
        children,
      );
    },
  };
});

import { MatchChatMetalHalo } from "./MatchChatMetalHalo";

type MediaHarness = {
  setMatches(matches: boolean): void;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};

const originalOffscreenCanvas = globalThis.OffscreenCanvas;

let reducedMotion: MediaHarness;
let visibilityState: DocumentVisibilityState;
let intersectionCallbacks: Set<IntersectionObserverCallback>;
let intersectionDisconnects: Array<ReturnType<typeof vi.fn>>;

function installMatchMedia(): MediaHarness {
  let matches = false;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn(
    (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  );

  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        get matches() {
          return matches;
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener,
        removeEventListener,
        dispatchEvent: vi.fn(),
      }) as MediaQueryList,
  );

  return {
    addEventListener,
    removeEventListener,
    setMatches(next) {
      matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function reportIntersection(isIntersecting: boolean) {
  for (const callback of intersectionCallbacks) {
    callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  }
}

function setDocumentVisibility(next: DocumentVisibilityState) {
  visibilityState = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function metalSlot(container: HTMLElement) {
  const slot = container.querySelector<HTMLElement>("[data-match-chat-metal]");
  expect(slot).not.toBeNull();
  return slot!;
}

type OffscreenCanvasMode =
  | "supported"
  | "null-context"
  | "constructor-throws"
  | "get-context-throws";

function installOffscreenCanvas(mode: OffscreenCanvasMode) {
  const loseContext = vi.fn();
  const getExtension = vi.fn((name: string) =>
    name === "WEBGL_lose_context" ? { loseContext } : null,
  );
  const getContext = vi.fn(
    (_contextId: string, _options?: WebGLContextAttributes) => {
      if (mode === "get-context-throws") {
        throw new Error("mock OffscreenCanvas getContext failure");
      }
      return mode === "null-context" ? null : { getExtension };
    },
  );
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();

  vi.stubGlobal(
    "OffscreenCanvas",
    class MockOffscreenCanvas {
      readonly addEventListener = addEventListener;
      readonly removeEventListener = removeEventListener;
      readonly getContext = getContext;

      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        if (mode === "constructor-throws") {
          throw new Error("mock OffscreenCanvas constructor failure");
        }
      }
    },
  );

  return { getContext, getExtension, loseContext };
}

async function flushEnhancement() {
  await act(async () => {
    await Promise.resolve();
    await vi.dynamicImportSettled();
  });
}

async function waitForMetalRuntime(container: HTMLElement) {
  await waitFor(() => {
    expect(
      container.querySelector("[data-mocked-metal-fx]"),
    ).toBeInTheDocument();
  });
}

async function waitForMetalRenderAttempt() {
  await waitFor(() => {
    expect(metalMock.rendered).toHaveBeenCalled();
  });
}

beforeEach(() => {
  metalMock.moduleLoaded.mockClear();
  metalMock.rendered.mockClear();
  metalMock.shouldThrow = false;
  document.documentElement.dataset.theme = "light";

  reducedMotion = installMatchMedia();
  visibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibilityState,
  );

  intersectionCallbacks = new Set();
  intersectionDisconnects = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      readonly disconnect = vi.fn(() => {
        intersectionCallbacks.delete(this.callback);
      });
      readonly observe = vi.fn();
      readonly takeRecords = () => [];
      readonly unobserve = vi.fn();

      constructor(private readonly callback: IntersectionObserverCallback) {
        intersectionCallbacks.add(callback);
        intersectionDisconnects.push(this.disconnect);
      }
    },
  );

  vi.stubGlobal(
    "ResizeObserver",
    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal("WebGLRenderingContext", class MockWebGLRenderingContext {});
  vi.stubGlobal(
    "CanvasRenderingContext2D",
    class MockCanvasRenderingContext2D {},
  );
  // SAFETY: this test double covers every context kind exercised by the capability probe.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    contextId: string,
  ) => {
    if (
      contextId === "webgl" ||
      contextId === "webgl2" ||
      contextId === "experimental-webgl"
    ) {
      const context: WebGLRenderingContext = Object.create(
        WebGLRenderingContext.prototype,
      );
      Object.defineProperty(context, "getExtension", {
        value: vi.fn(() => ({ loseContext: vi.fn() })),
      });
      return context;
    }
    if (contextId === "2d") {
      const context: CanvasRenderingContext2D = Object.create(
        CanvasRenderingContext2D.prototype,
      );
      Object.defineProperty(context, "roundRect", { value: vi.fn() });
      return context;
    }
    return null;
  }) as HTMLCanvasElement["getContext"]);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) =>
    window.clearTimeout(handle),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(globalThis.OffscreenCanvas).toBe(originalOffscreenCanvas);
  delete document.documentElement.dataset.theme;
});

describe("MatchChatMetalHalo", () => {
  it("server-renders only the inert static halo", () => {
    const markup = renderToString(
      createElement(MatchChatMetalHalo, { active: true }),
    );

    expect(markup).toContain("data-match-chat-metal");
    expect(markup).toContain('data-active="true"');
    expect(markup).toContain('data-renderer="static"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("inert");
    expect(markup).not.toContain("data-mocked-metal-fx");
    expect(metalMock.moduleLoaded).not.toHaveBeenCalled();
  });

  it("does not import or mount MetalFx while inactive", async () => {
    const { container } = render(<MatchChatMetalHalo active={false} />);
    await flushEnhancement();

    const slot = metalSlot(container);
    expect(slot).toHaveAttribute("data-active", "false");
    expect(slot).toHaveAttribute("data-renderer", "static");
    expect(slot).toHaveAttribute("data-motion", "paused");
    expect(slot).toHaveAttribute("data-theme", "light");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot).toHaveAttribute("inert");
    expect(metalMock.moduleLoaded).not.toHaveBeenCalled();
    expect(metalMock.rendered).not.toHaveBeenCalled();
  });

  it("dynamically mounts supported MetalFx and retires it after about 1.4 seconds", async () => {
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );
    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRuntime(container);

    const slot = metalSlot(container);
    expect(metalMock.moduleLoaded).toHaveBeenCalledOnce();
    expect(slot).toHaveAttribute("data-renderer", "metal-fx");
    expect(slot).toHaveAttribute("data-motion", "active");
    expect(slot).toHaveAttribute("data-active", "true");
    expect(slot.querySelector("[data-mocked-metal-fx]")).toBeInTheDocument();

    await act(
      async () => new Promise((resolve) => window.setTimeout(resolve, 1_300)),
    );
    expect(slot.querySelector("[data-mocked-metal-fx]")).toBeInTheDocument();

    await act(
      async () => new Promise((resolve) => window.setTimeout(resolve, 200)),
    );
    expect(slot).toHaveAttribute("data-renderer", "static");
    expect(
      slot.querySelector("[data-mocked-metal-fx]"),
    ).not.toBeInTheDocument();
  });

  it("keeps the static halo when OffscreenCanvas WebGL is null even if HTML WebGL works", async () => {
    const offscreen = installOffscreenCanvas("null-context");
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );

    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();

    const slot = metalSlot(container);
    expect(offscreen.getContext).toHaveBeenCalledWith("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    expect(slot).toHaveAttribute("data-renderer", "static");
    expect(slot).toHaveAttribute("data-motion", "paused");
    expect(metalMock.rendered).not.toHaveBeenCalled();
  });

  it("mounts the enhancement when OffscreenCanvas WebGL works", async () => {
    const offscreen = installOffscreenCanvas("supported");
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );

    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRuntime(container);

    const slot = metalSlot(container);
    expect(slot).toHaveAttribute("data-renderer", "metal-fx");
    expect(offscreen.getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(offscreen.loseContext).toHaveBeenCalledOnce();
  });

  it.each(["constructor-throws", "get-context-throws"] as const)(
    "keeps the static halo when OffscreenCanvas %s",
    async (mode) => {
      installOffscreenCanvas(mode);
      const { container, rerender } = render(
        <MatchChatMetalHalo active={false} />,
      );

      rerender(<MatchChatMetalHalo active />);
      act(() => reportIntersection(true));
      await flushEnhancement();

      const slot = metalSlot(container);
      expect(slot).toHaveAttribute("data-renderer", "static");
      expect(slot).toHaveAttribute("data-motion", "paused");
      expect(metalMock.rendered).not.toHaveBeenCalled();
    },
  );

  it("keeps the ordinary static halo when WebGL is unavailable", async () => {
    vi.stubGlobal("WebGLRenderingContext", undefined);
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );

    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();

    const slot = container.querySelector("[data-match-chat-metal]");
    expect(slot).toHaveAttribute("data-active", "true");
    expect(slot).toHaveAttribute("data-renderer", "static");
    expect(slot).toHaveAttribute("data-motion", "paused");
    expect(
      slot?.querySelector("[data-mocked-metal-fx]"),
    ).not.toBeInTheDocument();
  });

  it("keeps the runtime unmounted when reduced motion is requested", async () => {
    act(() => reducedMotion.setMatches(true));
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );
    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();

    const slot = metalSlot(container);
    expect(slot).toHaveAttribute("data-renderer", "static");
    expect(slot).toHaveAttribute("data-motion", "paused");
    expect(
      slot.querySelector("[data-mocked-metal-fx]"),
    ).not.toBeInTheDocument();
    expect(metalMock.rendered).not.toHaveBeenCalled();
  });

  it("unmounts while hidden or offscreen and can mount again after each recovery", async () => {
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );
    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRuntime(container);
    const slot = metalSlot(container);
    expect(slot.querySelector("[data-mocked-metal-fx]")).toBeInTheDocument();

    act(() => setDocumentVisibility("hidden"));
    expect(
      slot.querySelector("[data-mocked-metal-fx]"),
    ).not.toBeInTheDocument();
    expect(slot).toHaveAttribute("data-renderer", "static");

    act(() => setDocumentVisibility("visible"));
    await flushEnhancement();
    await waitForMetalRuntime(container);
    expect(slot.querySelector("[data-mocked-metal-fx]")).toBeInTheDocument();

    act(() => reportIntersection(false));
    expect(
      slot.querySelector("[data-mocked-metal-fx]"),
    ).not.toBeInTheDocument();

    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRuntime(container);
    expect(slot.querySelector("[data-mocked-metal-fx]")).toBeInTheDocument();
  });

  it("synchronizes its light and dark theme marker with the document theme", async () => {
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );
    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRuntime(container);
    const slot = metalSlot(container);

    expect(slot).toHaveAttribute("data-theme", "light");
    expect(slot.querySelector("[data-mocked-metal-fx]")).toHaveAttribute(
      "data-metal-theme",
      "light",
    );

    act(() => document.documentElement.setAttribute("data-theme", "dark"));
    await flushEnhancement();
    expect(slot).toHaveAttribute("data-theme", "dark");
    expect(slot.querySelector("[data-mocked-metal-fx]")).toHaveAttribute(
      "data-metal-theme",
      "dark",
    );
  });

  it("cleans up media, visibility, observer, animation, and retirement timer work", async () => {
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const disconnectThemeObserver = vi.spyOn(
      MutationObserver.prototype,
      "disconnect",
    );
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { rerender, unmount } = render(<MatchChatMetalHalo active={false} />);
    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRuntime(document.body);

    const visibilityRegistration = addDocumentListener.mock.calls.find(
      ([type]) => type === "visibilitychange",
    );
    expect(visibilityRegistration).toBeDefined();
    expect(reducedMotion.addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );

    unmount();

    expect(reducedMotion.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(
      removeDocumentListener.mock.calls.some(
        ([type, listener]) =>
          type === "visibilitychange" &&
          listener === visibilityRegistration![1],
      ),
    ).toBe(true);
    expect(intersectionDisconnects).not.toHaveLength(0);
    expect(
      intersectionDisconnects.every(
        (disconnect) => disconnect.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(disconnectThemeObserver).toHaveBeenCalled();
    expect(clearTimeout).toHaveBeenCalled();
    expect(intersectionCallbacks).toHaveLength(0);
  });

  it("isolates a throwing MetalFx behind an error boundary and keeps the root slot", async () => {
    metalMock.shouldThrow = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { container, rerender } = render(
      <MatchChatMetalHalo active={false} />,
    );
    rerender(<MatchChatMetalHalo active />);
    act(() => reportIntersection(true));
    await flushEnhancement();
    await waitForMetalRenderAttempt();

    const slot = metalSlot(container);
    expect(slot).toHaveAttribute("data-match-chat-metal");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot).toHaveAttribute("inert");
    expect(
      slot.querySelector("[data-mocked-metal-fx]"),
    ).not.toBeInTheDocument();
    expect(metalMock.rendered).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
