"use client";

import { Button } from "@appica/ui-react/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { InterfaceLocale } from "../lib/preferences";

interface HorizontalTabScrollerProps {
  activeKey: string;
  children: ReactNode;
  className?: string;
  locale: InterfaceLocale;
}

interface ScrollState {
  atEnd: boolean;
  atStart: boolean;
  overflowing: boolean;
}

const initialScrollState: ScrollState = {
  atEnd: true,
  atStart: true,
  overflowing: false,
};

export function HorizontalTabScroller({
  activeKey,
  children,
  className = "",
  locale,
}: HorizontalTabScrollerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] =
    useState<ScrollState>(initialScrollState);

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const overflowing = viewport.scrollWidth > viewport.clientWidth + 1;
    const atStart = viewport.scrollLeft <= 1;
    const atEnd =
      viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;

    setScrollState((current) => {
      if (
        current.overflowing === overflowing &&
        current.atStart === atStart &&
        current.atEnd === atEnd
      ) {
        return current;
      }
      return { atEnd, atStart, overflowing };
    });
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(viewport);
    if (viewport.firstElementChild) {
      observer.observe(viewport.firstElementChild);
    }

    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [updateScrollState]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !scrollState.overflowing) return;

    const activeTab = viewport.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    activeTab?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "nearest",
      inline: "nearest",
    });
  }, [activeKey, scrollState.overflowing]);

  const scrollByPage = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.scrollBy({
      behavior: scrollBehavior(),
      left: direction * Math.max(viewport.clientWidth * 0.75, 120),
    });
  };

  const english = locale === "en";
  const previousLabel = english
    ? "Scroll tabs backward"
    : "向前滚动标签页";
  const nextLabel = english ? "Scroll tabs forward" : "向后滚动标签页";

  return (
    <div
      className={`flex min-w-0 items-center gap-1 ${className}`.trim()}
      data-horizontal-tab-scroller="true"
    >
      {scrollState.overflowing ? (
        <Button
          aria-label={previousLabel}
          title={previousLabel}
          className="min-h-11 min-w-11 shrink-0"
          disabled={scrollState.atStart}
          size="icon-md"
          type="button"
          variant="outline"
          onClick={() => scrollByPage(-1)}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </Button>
      ) : null}
      <div
        ref={viewportRef}
        className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-horizontal-tab-scroller-viewport="true"
      >
        {children}
      </div>
      {scrollState.overflowing ? (
        <Button
          aria-label={nextLabel}
          title={nextLabel}
          className="min-h-11 min-w-11 shrink-0"
          disabled={scrollState.atEnd}
          size="icon-md"
          type="button"
          variant="outline"
          onClick={() => scrollByPage(1)}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
