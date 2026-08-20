"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@appica/ui-react/dialog";
import { Button } from "@appica/ui-react/button";

export interface WorkspaceSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  backdropLabel?: string;
}

/** Appica-powered, controlled workspace dialog for account and role preferences. */
export function WorkspaceSettingsDialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  closeLabel = "Close workspace settings",
  backdropLabel = "Close workspace settings dialog",
}: WorkspaceSettingsDialogProps) {
  const titleId = useId();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dialogClassName = ["workspace-settings-dialog", "appica-workspace-settings-dialog", className]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      previous?.focus();
    };
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className={dialogClassName}
        closeButton={false}
        closeLabel={backdropLabel}
        frame={false}
        aria-labelledby={titleId}
      >
        <DialogHeader className="workspace-settings-header">
          <div>
            <DialogTitle id={titleId}>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </div>
          <Button
            className="workspace-settings-close"
            variant="outline"
            size="icon-sm"
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </Button>
        </DialogHeader>
        <DialogBody className="workspace-settings-content">{children}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
