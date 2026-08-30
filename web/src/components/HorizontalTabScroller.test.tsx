import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InterfaceLocale } from "../lib/preferences";
import { HorizontalTabScroller } from "./HorizontalTabScroller";

let viewportClientWidth = 240;
let viewportScrollWidth = 240;
const scrollByMock = vi.fn(function (
  this: HTMLElement,
  options: ScrollToOptions,
) {
  this.scrollLeft += Number(options.left ?? 0);
  this.dispatchEvent(new Event("scroll"));
});
const scrollIntoViewMock = vi.fn();

function renderScroller({
  activeKey = "first",
  locale = "zh",
}: {
  activeKey?: string;
  locale?: InterfaceLocale;
} = {}) {
  return render(
    <HorizontalTabScroller activeKey={activeKey} locale={locale}>
      <div role="tablist" aria-label="Sections" className="min-w-max">
        <button
          type="button"
          role="tab"
          aria-selected={activeKey === "first"}
        >
          First
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeKey === "second"}
        >
          Second destination
        </button>
      </div>
    </HorizontalTabScroller>,
  );
}

function notifyResize() {
  act(() => window.dispatchEvent(new Event("resize")));
}

describe("HorizontalTabScroller", () => {
  beforeEach(() => {
    viewportClientWidth = 240;
    viewportScrollWidth = 240;
    scrollByMock.mockClear();
    scrollIntoViewMock.mockClear();

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.hasAttribute("data-horizontal-tab-scroller-viewport")
          ? viewportClientWidth
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return this.hasAttribute("data-horizontal-tab-scroller-viewport")
          ? viewportScrollWidth
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollBy", {
      configurable: true,
      value: scrollByMock,
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows localized 44px controls only for overflow and supports keyboard scrolling", async () => {
    const user = userEvent.setup();
    const { rerender } = renderScroller();

    expect(
      screen.queryByRole("button", { name: "向前滚动标签页" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "向后滚动标签页" }),
    ).not.toBeInTheDocument();

    viewportScrollWidth = 640;
    notifyResize();

    const previous = await screen.findByRole("button", {
      name: "向前滚动标签页",
    });
    const next = screen.getByRole("button", { name: "向后滚动标签页" });
    expect(previous).toBeDisabled();
    expect(previous).toHaveClass("min-h-11", "min-w-11");
    expect(next).toBeEnabled();

    next.focus();
    await user.keyboard("{Enter}");
    expect(scrollByMock).toHaveBeenCalledWith({
      behavior: "smooth",
      left: 180,
    });

    rerender(
      <HorizontalTabScroller activeKey="first" locale="en">
        <div role="tablist">
          <button type="button" role="tab" aria-selected="true">
            First
          </button>
        </div>
      </HorizontalTabScroller>,
    );
    expect(
      screen.getByRole("button", { name: "Scroll tabs backward" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Scroll tabs forward" }),
    ).toBeInTheDocument();
  });

  it("scrolls the newly active tab into view without changing tab semantics", async () => {
    viewportScrollWidth = 640;
    const { rerender } = renderScroller();
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    scrollIntoViewMock.mockClear();

    rerender(
      <HorizontalTabScroller activeKey="second" locale="zh">
        <div role="tablist" aria-label="Sections">
          <button type="button" role="tab" aria-selected="false">
            First
          </button>
          <button type="button" role="tab" aria-selected="true">
            Second destination
          </button>
        </div>
      </HorizontalTabScroller>,
    );

    await waitFor(() =>
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      }),
    );
    expect(screen.getByRole("tablist", { name: "Sections" })).toContainElement(
      screen.getByRole("tab", { name: "Second destination" }),
    );
  });

  it("uses immediate scrolling when reduced motion is requested", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    viewportScrollWidth = 640;
    const user = userEvent.setup();
    renderScroller();

    const next = await screen.findByRole("button", {
      name: "向后滚动标签页",
    });
    await user.click(next);

    expect(scrollByMock).toHaveBeenCalledWith({
      behavior: "auto",
      left: 180,
    });
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  });
});
