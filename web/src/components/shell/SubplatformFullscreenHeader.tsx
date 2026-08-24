"use client";

import { ChevronLeft, Store } from "lucide-react";
import { NotificationBell } from "../NotificationBell";
import type { SubplatformConfig } from "../../subplatform";
import type { InterfaceLocale } from "../../lib/preferences";
import type { WorkspaceRole } from "../../types";
import type { AuthenticatedUser } from "../../hooks/useAuthSession";
import { parentPlatformHref } from "../../hooks/useSubplatformRoute";

interface SubplatformFullscreenHeaderProps {
  subplatform: SubplatformConfig;
  role: WorkspaceRole;
  locale: InterfaceLocale;
  authUser: AuthenticatedUser | null;
  hasCurrentManagedStore: boolean;
  onManageStore: () => void;
  ui: {
    backToParent: string;
    manageStore: string;
  };
}

export function SubplatformFullscreenHeader({
  subplatform,
  role,
  locale,
  authUser,
  hasCurrentManagedStore,
  onManageStore,
  ui,
}: SubplatformFullscreenHeaderProps) {
  return (
    <header className="subplatform-fullscreen-header">
      <a
        className="subplatform-back-link"
        href={parentPlatformHref(subplatform.path, role)}
        aria-label={ui.backToParent}
        title={ui.backToParent}
      >
        <ChevronLeft size={25} strokeWidth={1.75} aria-hidden="true" />
      </a>
      <div className="subplatform-fullscreen-actions">
        {hasCurrentManagedStore ? (
          <button
            className="subplatform-manage-link"
            type="button"
            onClick={onManageStore}
          >
            <Store size={16} aria-hidden="true" />
            {ui.manageStore}
          </button>
        ) : null}
        {authUser ? (
          <NotificationBell locale={locale} userId={authUser.id} />
        ) : null}
      </div>
    </header>
  );
}
