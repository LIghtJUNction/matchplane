"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu";
import { LayoutDashboard, LogIn, LogOut, Store, UserRound } from "lucide-react";
import { motion } from "motion/react";

import { Brand, spring } from "../Primitives";
import { PlatformMenu } from "../PlatformMenu";
import { PreferenceControls } from "../PreferenceControls";
import { NotificationBell } from "../NotificationBell";
import type { SubplatformConfig } from "../../subplatform";
import type {
  InterfaceLocale,
  InterfacePalette,
  InterfaceTextSize,
  InterfaceTheme,
} from "../../lib/preferences";
import type { WorkspaceRole } from "../../types";
import type { AuthenticatedUser } from "../../hooks/useAuthSession";
import { roleLabel } from "../../hooks/useSubplatformRoute";
import type { AccountSettingsSection } from "../../hooks/useSubplatformRoute";

interface PlatformHeaderProps {
  subplatform: SubplatformConfig;
  role: WorkspaceRole;
  theme: InterfaceTheme;
  locale: InterfaceLocale;
  palette: InterfacePalette;
  textSize: InterfaceTextSize;
  onThemeChange: (theme: InterfaceTheme) => void;
  onLocaleChange: (locale: InterfaceLocale) => void;
  onPaletteChange: (palette: InterfacePalette) => void;
  onTextSizeChange: (textSize: InterfaceTextSize) => void;
  authUser: AuthenticatedUser | null;
  authResolved: boolean;
  ownedStoresCount: number;
  ownedStoresError: string | null;
  ownedStoresResolved: boolean;
  onOpenSignIn: () => void;
  onOpenStoreCenter: () => void;
  onOpenAccountSection: (section: AccountSettingsSection) => void;
  onSignOut: () => void;
  ui: {
    rootPlatform: string;
    myStores: string;
    openStore: string;
    signIn: string;
    platformAdmin: string;
    accountMenu: string;
    user: string;
    unifiedIdentity: string;
    profile: string;
    account: string;
    signOut: string;
  };
}

export function PlatformHeader({
  subplatform,
  role,
  theme,
  locale,
  palette,
  textSize,
  onThemeChange,
  onLocaleChange,
  onPaletteChange,
  onTextSizeChange,
  authUser,
  authResolved,
  ownedStoresCount,
  ownedStoresError,
  ownedStoresResolved,
  onOpenSignIn,
  onOpenStoreCenter,
  onOpenAccountSection,
  onSignOut,
  ui,
}: PlatformHeaderProps) {
  const canOpenPlatformConsole =
    authUser?.role === "rootSuperAdmin" || authUser?.role === "rootAdmin";

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="brand-cluster">
          <Brand
            label={subplatform.brandName}
            logoUrl={
              subplatform.slug === "root" ? subplatform.brandLogoUrl : undefined
            }
            homeHref={subplatform.slug === "root" ? "#top" : subplatform.path}
          />
          {subplatform.slug === "root" ? (
            <PlatformMenu locale={locale} />
          ) : null}
          {subplatform.slug === "root" ? null : (
            <a className="root-platform-link" href="/">
              {ui.rootPlatform}
            </a>
          )}
        </div>
        <div className="header-actions">
          <PreferenceControls
            theme={theme}
            locale={locale}
            palette={palette}
            textSize={textSize}
            onThemeChange={onThemeChange}
            onLocaleChange={onLocaleChange}
            onPaletteChange={onPaletteChange}
            onTextSizeChange={onTextSizeChange}
          />
          {!authUser ? (
            <motion.button
              className="header-store-action"
              type="button"
              onClick={onOpenStoreCenter}
              whileTap={{ scale: 0.97 }}
              transition={spring}
            >
              <Store size={17} aria-hidden="true" />
              <span>{ui.openStore}</span>
            </motion.button>
          ) : null}
          {!authUser && authResolved ? (
            <motion.button
              className="header-signin-action"
              type="button"
              onClick={onOpenSignIn}
              whileTap={{ scale: 0.97 }}
              transition={spring}
            >
              <LogIn size={17} aria-hidden="true" />
              <span>{ui.signIn}</span>
            </motion.button>
          ) : null}
          {authUser ? (
            <NotificationBell locale={locale} userId={authUser.id} />
          ) : null}
          {authUser ? (
            <DropdownMenu size="sm">
              <DropdownMenuTrigger
                render={
                  <motion.button
                    className="profile-button"
                    type="button"
                    aria-label={ui.accountMenu}
                    whileTap={{ scale: 0.95 }}
                    transition={spring}
                  >
                    <span className="profile-button-avatar">
                      {authUser.image ? (
                        <img src={authUser.image} alt="" />
                      ) : (
                        <UserRound size={18} aria-hidden="true" />
                      )}
                    </span>
                    <span className="profile-copy">
                      <strong>{authUser.name || ui.user}</strong>
                      <small>{roleLabel(role, locale, subplatform)}</small>
                    </span>
                  </motion.button>
                }
              />
              <DropdownMenuContent
                className="account-menu"
                align="end"
                sideOffset={10}
                aria-label={ui.accountMenu}
              >
                <div className="account-menu-identity">
                  <strong>{authUser.name || ui.user}</strong>
                  <small>{authUser.email || ui.unifiedIdentity}</small>
                </div>
                <div className="account-menu-links">
                  <DropdownMenuItem
                    onClick={() => onOpenAccountSection("profile")}
                  >
                    <UserRound size={16} aria-hidden="true" />
                    {ui.profile}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onOpenAccountSection("account")}
                  >
                    <UserRound size={16} aria-hidden="true" />
                    {ui.account}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    aria-label={ui.myStores}
                    onClick={() => onOpenAccountSection("stores")}
                  >
                    <Store size={16} aria-hidden="true" />
                    <span>{ui.myStores}</span>
                    {ownedStoresResolved && !ownedStoresError ? (
                      <strong className="account-menu-count">
                        {ownedStoresCount}
                      </strong>
                    ) : ownedStoresError ? (
                      <span
                        className="account-menu-count is-error"
                        title={ownedStoresError}
                        aria-label={
                          locale === "en"
                            ? "Store list unavailable"
                            : "店铺列表暂不可用"
                        }
                      >
                        !
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                  {canOpenPlatformConsole ? (
                    <DropdownMenuLinkItem render={<a href="/?role=platform" />}>
                      <LayoutDashboard size={16} aria-hidden="true" />
                      <span>{ui.platformAdmin}</span>
                    </DropdownMenuLinkItem>
                  ) : null}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="account-menu-signout"
                  onClick={onSignOut}
                >
                  <LogOut size={16} aria-hidden="true" />
                  {ui.signOut}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </header>
  );
}
