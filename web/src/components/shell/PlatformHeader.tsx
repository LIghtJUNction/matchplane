"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu";
import { LogIn, LogOut, Store, UserRound } from "lucide-react";
import { motion } from "motion/react";

import { Brand, spring } from "../Primitives";
import { PlatformMenu } from "../PlatformMenu";
import { PreferenceControls } from "../PreferenceControls";
import { NotificationBell } from "../NotificationBell";
import type { SubplatformConfig } from "../../subplatform";
import type {
  InterfaceLocale,
  InterfacePalette,
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
  onThemeChange: (theme: InterfaceTheme) => void;
  onLocaleChange: (locale: InterfaceLocale) => void;
  onPaletteChange: (palette: InterfacePalette) => void;
  authUser: AuthenticatedUser | null;
  authResolved: boolean;
  ownedStoresCount: number;
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
  onThemeChange,
  onLocaleChange,
  onPaletteChange,
  authUser,
  authResolved,
  ownedStoresCount,
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
            onThemeChange={onThemeChange}
            onLocaleChange={onLocaleChange}
            onPaletteChange={onPaletteChange}
          />
          <motion.button
            className="header-store-action"
            type="button"
            onClick={onOpenStoreCenter}
            whileTap={{ scale: 0.97 }}
            transition={spring}
          >
            <Store size={17} aria-hidden="true" />
            <span>{authUser ? ui.myStores : ui.openStore}</span>
            {authUser && ownedStoresResolved ? (
              <strong
                className="header-store-count"
                aria-label={`${ui.myStores}: ${ownedStoresCount}`}
              >
                {ownedStoresCount}
              </strong>
            ) : null}
          </motion.button>
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
                    {ownedStoresResolved ? (
                      <strong className="account-menu-count">
                        {ownedStoresCount}
                      </strong>
                    ) : null}
                  </DropdownMenuItem>
                  {canOpenPlatformConsole ? (
                    <DropdownMenuLinkItem render={<a href="/?role=platform" />}>
                      <UserRound size={16} aria-hidden="true" />
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
