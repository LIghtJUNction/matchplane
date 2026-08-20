"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { getPlatformChildren, type PlatformChildSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

interface PlatformMenuProps {
  locale: InterfaceLocale;
  platformPath?: string;
}

/** A compact, registry-backed platform menu for the root navigation. */
export function PlatformMenu({ locale, platformPath = "/" }: PlatformMenuProps) {
  const [children, setChildren] = useState<PlatformChildSummary[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = locale === "en" ? "Platforms" : "平台";

  useEffect(() => {
    let active = true;
    void getPlatformChildren(platformPath)
      .then((items) => {
        if (active) setChildren(items);
      })
      .catch(() => {
        if (active) setChildren([]);
      });
    return () => {
      active = false;
    };
  }, [platformPath]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!children.length) return null;

  return (
    <div className="platform-menu" ref={rootRef}>
      <button
        className="platform-menu-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <nav className="platform-menu-popover" id={menuId} aria-label={label}>
          <ul className="platform-menu-grid">
            {children.map((child) => (
              <li key={child.path}>
                <a href={child.path} onClick={() => setOpen(false)}>
                  <strong>{child.displayName}</strong>
                  {child.description ? <span>{child.description}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
