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
import { MessageSquareMore, X } from "lucide-react";
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
        const title = isZh ? "选货员" : "Shopping assistant";
        const description = isZh
                ? "描述需求，比较真实在售商品。"
                : "Describe your needs and compare real listings.";
        const launcherText =
                launcherLabel ?? (isZh ? "问选货员" : "Ask assistant");

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
                                  aria-label={launcherText}
                                  aria-haspopup="dialog"
                                  aria-expanded={open}
                                  onClick={() => onOpenChange(true)}
                          >
                                  <MessageSquareMore
                                          size={17}
                                          aria-hidden="true"
                                  />
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
                                                className="desktop-clerk-dialog"
                                                closeButton={false}
                                                closeLabel={
                                                        isZh
                                                                ? "关闭选货员"
                                                                : "Close shopping assistant"
                                                }
                                                frame={false}
                                                viewportProps={{
                                                        className: "desktop-clerk-dialog-viewport",
                                                }}
                                        >
                                                <DialogHeader className="desktop-clerk-dialog-header">
                                                        <div>
                                                                <DialogTitle>
                                                                        {title}
                                                                </DialogTitle>
                                                                <DialogDescription>
                                                                        {
                                                                                description
                                                                        }
                                                                </DialogDescription>
                                                        </div>
                                                        <DialogClose
                                                                render={
                                                                        <Button
                                                                                className="floating-clerk-action"
                                                                                variant="ghost"
                                                                                size="icon-md"
                                                                                type="button"
                                                                                aria-label={
                                                                                        isZh
                                                                                                ? "关闭选货员"
                                                                                                : "Close shopping assistant"
                                                                                }
                                                                        >
                                                                                <X aria-hidden="true" />
                                                                        </Button>
                                                                }
                                                        />
                                                </DialogHeader>
                                                <DialogBody className="floating-clerk-content">
                                                        {children}
                                                </DialogBody>
                                        </DialogContent>
                                </Dialog>
                        ) : (
                                <Drawer
                                        open={open}
                                        onOpenChange={onOpenChange}
                                        side="bottom"
                                >
                                        <DrawerContent
                                                className="mobile-clerk-drawer"
                                                backdropProps={{
                                                        className: "root-marketplace-clerk-backdrop",
                                                }}
                                        >
                                                <DrawerHeader className="mobile-clerk-drawer-header">
                                                        <div>
                                                                <DrawerTitle>
                                                                        {title}
                                                                </DrawerTitle>
                                                                <DrawerDescription>
                                                                        {
                                                                                description
                                                                        }
                                                                </DrawerDescription>
                                                        </div>
                                                        <DrawerClose
                                                                render={
                                                                        <Button
                                                                                className="floating-clerk-action"
                                                                                variant="ghost"
                                                                                size="icon-md"
                                                                                type="button"
                                                                                aria-label={
                                                                                        isZh
                                                                                                ? "关闭选货员"
                                                                                                : "Close shopping assistant"
                                                                                }
                                                                        >
                                                                                <X aria-hidden="true" />
                                                                        </Button>
                                                                }
                                                        />
                                                </DrawerHeader>
                                                <DrawerBody className="mobile-clerk-drawer-body">
                                                        {children}
                                                </DrawerBody>
                                        </DrawerContent>
                                </Drawer>
                        )}
                        {launcher}
                </>
        );
}
