"use client";

import { Button } from "@appica/ui-react/button";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@appica/ui-react/drawer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appica/ui-react/collapsible";
import { useMediaQuery } from "@appica/ui-react/hooks/use-media-query";
import {
  GripHorizontal,
  Maximize2,
  Search,
  Minimize2,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Rnd } from "react-rnd";

import type { InterfaceLocale } from "../lib/preferences";

interface FloatingMarketplaceClerkProps {
  open: boolean;
  locale: InterfaceLocale;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

interface ClerkLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VIEWPORT_GUTTER = 16;
const COLLAPSED_HEIGHT = 68;

function initialLayout(): ClerkLayout {
  if (typeof window === "undefined") {
    return { x: VIEWPORT_GUTTER, y: VIEWPORT_GUTTER, width: 400, height: 560 };
  }
  const width = Math.min(400, window.innerWidth - VIEWPORT_GUTTER * 2);
  const height = Math.min(560, window.innerHeight - VIEWPORT_GUTTER * 2);
  return {
    width,
    height,
    x: Math.max(VIEWPORT_GUTTER, window.innerWidth - width - 24),
    y: Math.max(VIEWPORT_GUTTER, window.innerHeight - height - 24),
  };
}

function clampLayout(layout: ClerkLayout): ClerkLayout {
  if (typeof window === "undefined") return layout;
  const width = Math.min(layout.width, window.innerWidth - VIEWPORT_GUTTER * 2);
  const height = Math.min(
    layout.height,
    window.innerHeight - VIEWPORT_GUTTER * 2,
  );
  return {
    width,
    height,
    x: Math.min(
      Math.max(VIEWPORT_GUTTER, layout.x),
      Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER),
    ),
    y: Math.min(
      Math.max(VIEWPORT_GUTTER, layout.y),
      Math.max(VIEWPORT_GUTTER, window.innerHeight - height - VIEWPORT_GUTTER),
    ),
  };
}

export function FloatingMarketplaceClerk({
  open,
  locale,
  onOpenChange,
  children,
}: FloatingMarketplaceClerkProps) {
  const isDesktop = useMediaQuery("(min-width: 48rem)");
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [layout, setLayout] = useState<ClerkLayout>(initialLayout);
  const isZh = locale === "zh";

  useEffect(() => {
    setPortalNode(document.body);
    setLayout(initialLayout());
    const keepInViewport = () => setLayout((current) => clampLayout(current));
    window.addEventListener("resize", keepInViewport);
    return () => window.removeEventListener("resize", keepInViewport);
  }, []);

  useEffect(() => {
    if (!open || !isDesktop) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isDesktop, onOpenChange, open]);

  const showClerk = () => {
    setCollapsed(false);
    onOpenChange(true);
  };

  const launcher = portalNode
    ? createPortal(
        <Button
          className={`root-marketplace-clerk-toggle${open ? " is-hidden" : ""}`}
          type="button"
          aria-controls="marketplace-clerk-panel"
          aria-expanded={open}
          aria-label={isZh ? "打开找商品" : "Open product search"}
          onClick={showClerk}
        >
          <Search aria-hidden="true" />
          <span>{isZh ? "帮我找" : "Find items"}</span>
        </Button>,
        portalNode,
      )
    : null;

  if (!portalNode) return null;

  if (!isDesktop) {
    return (
      <>
        {launcher}
        <Drawer
          side="bottom"
          modal={false}
          open={open}
          onOpenChange={onOpenChange}
        >
          <DrawerContent
            className="mobile-clerk-drawer"
            closeButton={false}
            frame={false}
            backdrop
          >
            <DrawerHeader className="mobile-clerk-drawer-header">
              <div>
                <DrawerTitle>
                  {isZh ? "找商品" : "Find products"}
                </DrawerTitle>
                <DrawerDescription>
                  {isZh
                    ? "填写预算、用途或偏好。"
                    : "Enter your budget, use case, or preferences."}
                </DrawerDescription>
              </div>
              <DrawerClose
                render={
                  <Button
                    className="floating-clerk-action"
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={isZh ? "关闭" : "Close"}
                  >
                    <X aria-hidden="true" />
                  </Button>
                }
              />
            </DrawerHeader>
            <DrawerBody
              className="mobile-clerk-drawer-body"
              id="marketplace-clerk-panel"
            >
              {children}
            </DrawerBody>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <>
      {launcher}
      {createPortal(
        <div className="floating-clerk-viewport" aria-hidden={!open}>
          <Rnd
            bounds="parent"
            cancel=".floating-clerk-action, .root-marketplace-search"
            className={`floating-clerk-rnd${open ? " is-open" : " is-stowed"}`}
            disableDragging={!open}
            dragHandleClassName="floating-clerk-drag-handle"
            enableResizing={open && !collapsed}
            minWidth={340}
            minHeight={440}
            maxWidth="calc(100vw - 2rem)"
            maxHeight="calc(100dvh - 2rem)"
            position={{ x: layout.x, y: layout.y }}
            size={{
              width: layout.width,
              height: collapsed ? COLLAPSED_HEIGHT : layout.height,
            }}
            onDragStop={(_event, position) =>
              setLayout((current) => ({
                ...current,
                x: position.x,
                y: position.y,
              }))
            }
            onResizeStop={(_event, _direction, element, _delta, position) =>
              setLayout({
                x: position.x,
                y: position.y,
                width: element.offsetWidth,
                height: element.offsetHeight,
              })
            }
          >
            <Collapsible
              className="floating-clerk-window"
              open={!collapsed}
              onOpenChange={(expanded) => setCollapsed(!expanded)}
            >
              <header className="floating-clerk-drag-handle">
                <GripHorizontal
                  className="floating-clerk-grip"
                  aria-hidden="true"
                />
                <div>
                  <strong>{isZh ? "找商品" : "Find products"}</strong>
                  <span>
                    {collapsed
                      ? isZh
                        ? "已收起，拖动标题栏或展开继续"
                        : "Stowed — drag or expand to continue"
                      : isZh
                        ? "可拖动、缩放和收起"
                        : "Move, resize, or stow this panel"}
                  </span>
                </div>
                <CollapsibleTrigger
                  render={
                    <Button
                      className="floating-clerk-action"
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label={
                        collapsed
                          ? isZh
                            ? "展开"
                            : "Expand"
                          : isZh
                            ? "收起"
                            : "Stow"
                      }
                    >
                      {collapsed ? (
                        <Maximize2 aria-hidden="true" />
                      ) : (
                        <Minimize2 aria-hidden="true" />
                      )}
                    </Button>
                  }
                />
                <Button
                  className="floating-clerk-action"
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  aria-label={isZh ? "关闭" : "Close"}
                  onClick={() => onOpenChange(false)}
                >
                  <X aria-hidden="true" />
                </Button>
              </header>
              <CollapsibleContent
                className="floating-clerk-content"
                id="marketplace-clerk-panel"
              >
                {children}
              </CollapsibleContent>
            </Collapsible>
          </Rnd>
        </div>,
        portalNode,
      )}
    </>
  );
}
