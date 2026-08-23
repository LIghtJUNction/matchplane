"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search, X, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@appica/ui-react/dialog";
import { Button } from "@appica/ui-react/button";

interface WorkspaceSettingsNavigationItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

export interface WorkspaceSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  backdropLabel?: string;
  navigation?: WorkspaceSettingsNavigationItem[];
  navigationLabel?: string;
  activeNavigationId?: string;
  onNavigationChange?: (id: string) => void;
  searchLabel?: string;
  emptyNavigationLabel?: string;
}

/** Controlled two-pane settings dialog shared by account, store and memory surfaces. */
export function WorkspaceSettingsDialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  closeLabel = "Close workspace settings",
  backdropLabel = "Close workspace settings dialog",
  navigation = [],
  navigationLabel,
  activeNavigationId,
  onNavigationChange,
  searchLabel,
  emptyNavigationLabel = "No settings found",
}: WorkspaceSettingsDialogProps) {
  const titleId = useId();
  const searchId = useId();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const showSearch = Boolean(searchLabel) && navigation.length >= 6;
  const dialogClassName = [
    "workspace-settings-dialog",
    "appica-workspace-settings-dialog",
    navigation.length ? "has-navigation" : "has-single-pane",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const visibleNavigation = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return navigation;
    return navigation.filter((item) =>
      item.label.toLocaleLowerCase().includes(normalized),
    );
  }, [navigation, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
        <div className="workspace-settings-layout">
          <aside
            className="workspace-settings-rail"
            aria-label={navigationLabel || title}
          >
            <Button
              className="workspace-settings-close"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X size={20} aria-hidden="true" />
            </Button>

            {showSearch ? (
              <label className="workspace-settings-search" htmlFor={searchId}>
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">{searchLabel}</span>
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  placeholder={searchLabel}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
            ) : null}

            {navigation.length ? (
              <nav className="workspace-settings-navigation">
                {visibleNavigation.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === activeNavigationId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => onNavigationChange?.(item.id)}
                    >
                      {Icon ? <Icon size={18} aria-hidden="true" /> : null}
                      <span>{item.label}</span>
                      {typeof item.count === "number" ? (
                        <small>{item.count}</small>
                      ) : null}
                    </button>
                  );
                })}
                {visibleNavigation.length ? null : (
                  <p className="workspace-settings-navigation-empty">
                    {emptyNavigationLabel}
                  </p>
                )}
              </nav>
            ) : (
              <div
                className="workspace-settings-single-destination"
                aria-current="page"
              >
                {title}
              </div>
            )}
          </aside>

          <section className="workspace-settings-main">
            <DialogHeader className="workspace-settings-header">
              <div>
                <DialogTitle id={titleId}>{title}</DialogTitle>
                {description ? (
                  <DialogDescription>{description}</DialogDescription>
                ) : null}
              </div>
            </DialogHeader>
            <DialogBody
              className="workspace-settings-content"
              role="region"
              aria-labelledby={titleId}
              tabIndex={0}
            >
              {children}
            </DialogBody>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
