"use client";

import { AnimatePresence, motion } from "motion/react";
import { LogOut, ShieldCheck, Store, UserRound, X } from "lucide-react";

import { ListingSheet, ModeDialog } from "../Overlays";
import { WorkspaceSettingsDialog } from "../WorkspaceSettingsDialog";
import { SubplatformAdminDashboard } from "../SubplatformAdminDashboard";
import { PreferenceControls } from "../PreferenceControls";
import { PersonalProfilePanel } from "../PersonalProfilePanel";
import { ChangePasswordPanel } from "../ChangePasswordPanel";
import { IdentityBindingsPanel } from "../IdentityBindingsPanel";
import { PasskeyPanel } from "../PasskeyPanel";
import { SessionPanel } from "../SessionPanel";
import { HostedStoreOnboarding } from "../HostedStoreOnboarding";

import type { AssetListing, WorkspaceRole } from "../../types";
import type { SubplatformConfig } from "../../subplatform";
import type { StoreSummary } from "../../api";
import type {
  InterfaceLocale,
  InterfacePalette,
  InterfaceTextSize,
  InterfaceTheme,
} from "../../lib/preferences";
import type { AuthenticatedUser } from "../../hooks/useAuthSession";
import {
  requestedStoreConsoleSection,
  roleLabel,
  type AccountSettingsSection,
} from "../../hooks/useSubplatformRoute";
import type { StoreConsoleContext } from "../../hooks/useOwnedStores";
import { isLiveMarketplaceEnabled } from "../../api";

interface PlatformOverlaysHostProps {
  authUser: AuthenticatedUser | null;
  role: WorkspaceRole;
  locale: InterfaceLocale;
  theme: InterfaceTheme;
  palette: InterfacePalette;
  textSize: InterfaceTextSize;
  onThemeChange: (theme: InterfaceTheme) => void;
  onLocaleChange: (locale: InterfaceLocale) => void;
  onPaletteChange: (palette: InterfacePalette) => void;
  onTextSizeChange: (textSize: InterfaceTextSize) => void;
  subplatform: SubplatformConfig;
  fullscreenPlugin: boolean;
  storeConsoleOpen: boolean;
  setStoreConsoleOpen: (open: boolean) => void;
  storeConsoleContext: StoreConsoleContext | null;
  setStoreConsoleContext: React.Dispatch<React.SetStateAction<StoreConsoleContext | null>>;
  canManageStoreConsole: boolean;
  ownedStores: StoreSummary[];
  setOwnedStores: React.Dispatch<React.SetStateAction<StoreSummary[]>>;
  ownedStoresResolved: boolean;
  openStoreConsoleFor: (store: StoreSummary) => Promise<void>;
  accountSettingsSection: AccountSettingsSection | null;
  setAccountSettingsSection: (section: AccountSettingsSection | null) => void;
  setAuthUser: React.Dispatch<React.SetStateAction<AuthenticatedUser | null>>;
  onSignOut: () => void;
  listing: AssetListing | null;
  closeListing: () => void;
  onContactListing: (selected: AssetListing) => Promise<void>;
  modeDialogOpen: boolean;
  closeModeDialog: () => void;
  paymentMode: "test" | "production";
  confirmModeChange: () => void;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  ui: ReturnType<typeof import("../../hooks/useSubplatformRoute").appCopy>;
}

export function PlatformOverlaysHost({
  authUser,
  role,
  locale,
  theme,
  palette,
  textSize,
  onThemeChange,
  onLocaleChange,
  onPaletteChange,
  onTextSizeChange,
  subplatform,
  fullscreenPlugin,
  storeConsoleOpen,
  setStoreConsoleOpen,
  storeConsoleContext,
  setStoreConsoleContext,
  canManageStoreConsole,
  ownedStores,
  setOwnedStores,
  ownedStoresResolved,
  openStoreConsoleFor,
  accountSettingsSection,
  setAccountSettingsSection,
  setAuthUser,
  onSignOut,
  listing,
  closeListing,
  onContactListing,
  modeDialogOpen,
  closeModeDialog,
  paymentMode,
  confirmModeChange,
  notice,
  setNotice,
  ui,
}: PlatformOverlaysHostProps) {
  const selectedManagedStore = listing
    ? (ownedStores.find(
        (store) =>
          (listing.storeId && store.id === listing.storeId) ||
          store.path === listing.platformPath,
      ) ?? null)
    : null;

  return (
    <>
      {!authUser || !storeConsoleContext ? null : (
        <WorkspaceSettingsDialog
          open={storeConsoleOpen}
          onClose={() => setStoreConsoleOpen(false)}
          title={
            storeConsoleContext.subplatform.label ||
            storeConsoleContext.store.displayName
          }
          description={ui.manageStore}
          className="workspace-settings-dialog-wide workspace-settings-dialog-store-console"
          closeLabel={ui.closeStoreConsole}
          backdropLabel={ui.closeStoreConsoleDialog}
        >
          <SubplatformAdminDashboard
            locale={locale}
            onNotice={setNotice}
            subplatform={storeConsoleContext.subplatform}
            store={storeConsoleContext.store}
            canManageStore={canManageStoreConsole}
            initialSection={requestedStoreConsoleSection()}
            onStoreUpdated={(updated) => {
              setStoreConsoleContext((current) =>
                current && current.store.id === updated.id
                  ? { ...current, store: { ...current.store, ...updated } }
                  : current,
              );
              setOwnedStores((current) =>
                current.map((store) =>
                  store.id === updated.id ? { ...store, ...updated } : store,
                ),
              );
            }}
          />
        </WorkspaceSettingsDialog>
      )}

      {fullscreenPlugin || !authUser ? null : (
        <WorkspaceSettingsDialog
          open={Boolean(accountSettingsSection)}
          onClose={() => {
            setAccountSettingsSection(null);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLButtonElement>(".profile-button")
                ?.focus(),
            );
          }}
          title={
            accountSettingsSection === "account"
              ? ui.account
              : accountSettingsSection === "stores"
                ? `${ui.myStores}${ownedStoresResolved ? ` · ${ownedStores.length}` : ""}`
                : ui.profile
          }
          description={
            accountSettingsSection === "account"
              ? ui.accountDescription
              : accountSettingsSection === "stores"
                ? ui.myStoresDescription
                : ui.profileDescription
          }
          className={
            accountSettingsSection === "stores"
              ? "workspace-settings-dialog-wide workspace-settings-dialog-stores"
              : undefined
          }
          closeLabel={
            accountSettingsSection === "stores"
              ? ui.closeMyStores
              : accountSettingsSection === "profile"
                ? ui.closeProfile
                : ui.closeAccount
          }
          backdropLabel={
            accountSettingsSection === "stores"
              ? ui.closeMyStoresDialog
              : accountSettingsSection === "profile"
                ? ui.closeProfileDialog
                : ui.closeAccountDialog
          }
          navigation={[
            { id: "profile", label: ui.profile, icon: UserRound },
            { id: "account", label: ui.account, icon: ShieldCheck },
            {
              id: "stores",
              label: ui.myStores,
              icon: Store,
              count: ownedStoresResolved ? ownedStores.length : undefined,
            },
          ]}
          navigationLabel={locale === "en" ? "Account settings" : "账号设置"}
          activeNavigationId={accountSettingsSection ?? "profile"}
          onNavigationChange={(id) =>
            setAccountSettingsSection(id as AccountSettingsSection)
          }
          searchLabel={locale === "en" ? "Search settings" : "搜索设置"}
          emptyNavigationLabel={
            locale === "en" ? "No settings found" : "没有匹配的设置"
          }
        >
          {accountSettingsSection === "account" ? (
            <div className="workspace-settings-overview">
              <section
                className="workspace-settings-section workspace-account-section"
                aria-labelledby="workspace-account-title"
              >
                <div className="workspace-settings-section-heading">
                  <h3 id="workspace-account-title">{ui.account}</h3>
                  <span>{roleLabel(role, locale, subplatform)}</span>
                </div>
                <div className="workspace-account-row">
                  <span className="workspace-account-avatar">
                    {authUser.image ? (
                      <img src={authUser.image} alt="" />
                    ) : (
                      <UserRound size={19} aria-hidden="true" />
                    )}
                  </span>
                  <span className="workspace-account-copy">
                    <strong>{authUser.name || ui.user}</strong>
                    <small>{authUser.email || ui.unifiedIdentity}</small>
                  </span>
                  <button
                    className="workspace-account-action"
                    type="button"
                    onClick={onSignOut}
                  >
                    <LogOut size={16} aria-hidden="true" />
                    {ui.signOut}
                  </button>
                </div>
              </section>
              <section
                className="workspace-settings-section"
                aria-labelledby="workspace-preferences-title"
              >
                <div className="workspace-settings-section-heading">
                  <h3 id="workspace-preferences-title">
                    {locale === "en" ? "Display and language" : "显示与语言"}
                  </h3>
                </div>
                <PreferenceControls
                  mode="panel"
                  theme={theme}
                  locale={locale}
                  palette={palette}
                  textSize={textSize}
                  onThemeChange={onThemeChange}
                  onLocaleChange={onLocaleChange}
                  onPaletteChange={onPaletteChange}
                  onTextSizeChange={onTextSizeChange}
                />
              </section>
              <ChangePasswordPanel
                email={authUser.email}
                locale={locale}
                onNotice={setNotice}
              />
              <IdentityBindingsPanel
                locale={locale}
                subplatform={subplatform}
                onNotice={setNotice}
              />
              <PasskeyPanel
                locale={locale}
                subplatform={subplatform}
                accountLabel={authUser.email}
                onNotice={setNotice}
              />
              <SessionPanel
                locale={locale}
                subplatform={subplatform}
                onNotice={setNotice}
              />
            </div>
          ) : accountSettingsSection === "stores" ? (
            <div className="workspace-settings-overview">
              <HostedStoreOnboarding
                locale={locale}
                onNotice={setNotice}
                initialStores={ownedStores}
                onStoresChange={setOwnedStores}
                onManageStore={(store) => void openStoreConsoleFor(store)}
              />
            </div>
          ) : (
            <PersonalProfilePanel
              onNotice={setNotice}
              onAvatarChanged={(image) =>
                setAuthUser((current) =>
                  current ? { ...current, image } : current,
                )
              }
            />
          )}
        </WorkspaceSettingsDialog>
      )}

      <ListingSheet
        listing={listing}
        subplatform={subplatform}
        locale={locale}
        onClose={closeListing}
        contactDisabled={!isLiveMarketplaceEnabled()}
        onManage={
          selectedManagedStore
            ? () => {
                closeListing();
                if (typeof window !== "undefined") {
                  window.location.assign(
                    `${selectedManagedStore.path}?console=products`,
                  );
                }
              }
            : undefined
        }
        onContact={onContactListing}
      />

      <ModeDialog
        open={modeDialogOpen}
        currentMode={paymentMode}
        onClose={closeModeDialog}
        onConfirm={confirmModeChange}
      />

      <AnimatePresence>
        {notice ? (
          <motion.div
            className="app-notice"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
          >
            <i aria-hidden="true" />
            <span>{notice}</span>
            <button
              type="button"
              aria-label={locale === "en" ? "Dismiss message" : "关闭消息"}
              onClick={() => setNotice(null)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
