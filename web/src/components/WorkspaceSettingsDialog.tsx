"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
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

const DIALOG_TAB_STOP_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isAvailableTabStop(element: HTMLElement, dialog: HTMLElement) {
  if (element.tabIndex < 0 || element.matches(":disabled")) return false;
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hidden ||
      current.inert ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (current === dialog) break;
  }
  return true;
}

function keepTabFocusInsideDialog(event: KeyboardEvent<HTMLDivElement>) {
  if (
    event.key !== "Tab" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return;
  }

  const dialog = event.currentTarget;
  const tabStops = Array.from(
    dialog.querySelectorAll<HTMLElement>(DIALOG_TAB_STOP_SELECTOR),
  ).filter((element) => isAvailableTabStop(element, dialog));
  if (!tabStops.length) return;

  const first = tabStops[0];
  const last = tabStops[tabStops.length - 1];
  const active = document.activeElement;
  // Base UI's modal trap uses sibling focus guards and redirects from them on
  // the next animation frame. Cycle at the popup boundary so focus never
  // transiently leaves the element exposed as the dialog.
  if (event.shiftKey ? active === first : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

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
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
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
    const activeElement = document.activeElement;
    restoreFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null;
  }, [open]);

  return (
    <Dialog
      modal
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
        initialFocus={initialFocusRef}
        finalFocus={restoreFocusRef}
        aria-labelledby={titleId}
        onKeyDown={keepTabFocusInsideDialog}
      >
        <div className="workspace-settings-layout">
          <aside
            className="workspace-settings-rail"
            aria-label={navigationLabel || title}
          >
            <Button
              ref={initialFocusRef}
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
