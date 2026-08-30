"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { getStores, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

interface PlatformMenuProps {
  locale: InterfaceLocale;
}

/** A compact, registry-backed store menu for the marketplace navigation. */
export function PlatformMenu({ locale }: PlatformMenuProps) {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = locale === "en" ? "Stores" : "店铺";

  useEffect(() => {
    let active = true;
    void getStores()
      .then((items) => {
        if (active) setStores(items);
      })
      .catch(() => {
        if (active) setStores([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      )
        setOpen(false);
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

  if (!stores.length) return null;

  return (
    <div className="platform-menu" ref={rootRef}>
      <button
        className="platform-menu-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        style={{ minHeight: 44, minWidth: 44 }}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <nav className="platform-menu-popover" id={menuId} aria-label={label}>
          <ul className="platform-menu-grid">
            {stores.map((store) => (
              <li key={store.id}>
                <a href={store.path} onClick={() => setOpen(false)}>
                  <strong>{store.displayName}</strong>
                  {store.description ? <span>{store.description}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
