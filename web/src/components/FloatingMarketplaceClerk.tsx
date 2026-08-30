"use client";

import { Button } from "@appica/ui-react/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@appica/ui-react/dialog";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@appica/ui-react/drawer";
import { useMediaQuery } from "@appica/ui-react/hooks/use-media-query";
import { Search, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { InterfaceLocale } from "../lib/preferences";

interface FloatingMarketplaceClerkProps {
  open: boolean;
  locale: InterfaceLocale;
  onOpenChange: (open: boolean) => void;
  launcherLabel?: string;
  children: ReactNode;
}

export function FloatingMarketplaceClerk({
  open,
  locale,
  onOpenChange,
  launcherLabel,
  children,
}: FloatingMarketplaceClerkProps) {
  const isDesktop = useMediaQuery("(min-width: 48rem)");
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const isZh = locale === "zh";
  const title = isZh ? "找商品" : "Find products";
  const description = isZh
    ? "填写预算、用途或偏好。"
    : "Enter your budget, use case, or preferences.";
  const launcherText = launcherLabel ?? (isZh ? "帮我找" : "Find items");
  const launcherAria =
    launcherLabel ?? (isZh ? "打开找商品" : "Open product search");
  const closeLabel = isZh ? "关闭" : "Close";
  const panelClass = `floating-clerk-rnd${open ? " is-open" : " is-stowed"}`;

  useEffect(() => {
    setPortalNode(document.body);
  }, []);

  const launcher = portalNode
    ? createPortal(
        <Button
          className={`root-marketplace-clerk-toggle${open ? " is-hidden" : ""}`}
          variant="primary"
          size="sm"
          type="button"
          aria-label={launcherAria}
          aria-controls="marketplace-clerk-panel"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(true)}
        >
          <Search size={17} aria-hidden="true" />
          <span>{launcherText}</span>
        </Button>,
        portalNode,
      )
    : null;

  return (
    <>
      {isDesktop ? (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent
            className={`desktop-clerk-dialog ${panelClass}`}
            closeButton={false}
            closeLabel={closeLabel}
            frame={false}
            viewportProps={{
              className: "desktop-clerk-dialog-viewport",
            }}
          >
            <DialogHeader className="desktop-clerk-dialog-header">
              <div>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </div>
              <DialogClose
                render={
                  <Button
                    className="floating-clerk-action"
                    variant="ghost"
                    size="icon-md"
                    type="button"
                    aria-label={closeLabel}
                  >
                    <X aria-hidden="true" />
                  </Button>
                }
              />
            </DialogHeader>
            <DialogBody
              className="floating-clerk-content"
              id="marketplace-clerk-panel"
            >
              {children}
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : (
        <Drawer open={open} onOpenChange={onOpenChange} side="bottom">
          <DrawerContent
            className={`mobile-clerk-drawer ${panelClass}`}
            backdropProps={{
              className: "root-marketplace-clerk-backdrop",
            }}
          >
            <DrawerHeader className="mobile-clerk-drawer-header">
              <div>
                <DrawerTitle>{title}</DrawerTitle>
                <DrawerDescription>{description}</DrawerDescription>
              </div>
              <DrawerClose
                render={
                  <Button
                    className="floating-clerk-action"
                    variant="ghost"
                    size="icon-md"
                    type="button"
                    aria-label={closeLabel}
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
      )}
      {launcher}
    </>
  );
}
