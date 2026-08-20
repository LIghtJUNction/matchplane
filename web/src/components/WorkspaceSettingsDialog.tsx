"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";

import { spring } from "./Primitives";

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

/** A controlled, accessible dialog for workspace-level preferences and settings. */
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
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const reduceMotion = useReducedMotion();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [open]);

  const panelClassName = ["workspace-settings-dialog", className].filter(Boolean).join(" ");
  const motionState = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.96, y: 12 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.98, y: 8 },
      };

  return (
    <AnimatePresence>
      {open ? (
        <div className="workspace-settings-overlay">
          <motion.button
            className="workspace-settings-backdrop"
            type="button"
            aria-label={backdropLabel}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={spring}
          />
          <motion.section
            ref={panelRef}
            {...motionState}
            className={panelClassName}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            transition={spring}
          >
            <div className="workspace-settings-header">
              <div>
                <h2 id={titleId}>{title}</h2>
                {description ? <p id={descriptionId}>{description}</p> : null}
              </div>
              <motion.button
                ref={closeRef}
                className="workspace-settings-close"
                type="button"
                aria-label={closeLabel}
                onClick={onClose}
                whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                transition={spring}
              >
                <X size={19} aria-hidden="true" />
              </motion.button>
            </div>
            <div className="workspace-settings-content">{children}</div>
          </motion.section>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
