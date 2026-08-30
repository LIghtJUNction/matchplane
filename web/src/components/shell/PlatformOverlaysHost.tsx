"use client";

import { createContext, useContext, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@appica/ui-react/tabs";
import { LogOut, ShieldCheck, Store, UserRound, X } from "lucide-react";

import { ModeDialog } from "../Overlays";
import { WorkspaceSettingsDialog } from "../WorkspaceSettingsDialog";
import { PreferenceControls } from "../PreferenceControls";

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
  roleLabel,
  type AccountSettingsSection,
  type StoreConsoleSection,
} from "../../hooks/useSubplatformRoute";
import type { StoreConsoleContext } from "../../hooks/useOwnedStores";
import { isLiveMarketplaceEnabled } from "../../api";

const DeferredOverlayLocaleContext = createContext<InterfaceLocale>("zh");

function DeferredOverlayStatus() {
  const locale = useContext(DeferredOverlayLocaleContext);
  const message = locale === "en" ? "Loading…" : "正在加载…";

  return (
    <p
      className="workspace-settings-section"
      role="status"
      aria-label={message}
      aria-busy="true"
    >
      {message}
    </p>
  );
}

const DeferredListingSheet = dynamic(
  () => import("../ListingSheet").then((module) => module.ListingSheet),
  { loading: DeferredOverlayStatus },
);
const DeferredSubplatformAdminDashboard = dynamic(
  () =>
    import("../SubplatformAdminDashboard").then(
      (module) => module.SubplatformAdminDashboard,
    ),
  { loading: DeferredOverlayStatus },
);
const DeferredPersonalProfilePanel = dynamic(
  () =>
    import("../PersonalProfilePanel").then(
      (module) => module.PersonalProfilePanel,
    ),
  { loading: DeferredOverlayStatus },
);
const DeferredChangePasswordPanel = dynamic(
  () =>
    import("../ChangePasswordPanel").then(
      (module) => module.ChangePasswordPanel,
    ),
  { loading: DeferredOverlayStatus },
);
const DeferredIdentityBindingsPanel = dynamic(
  () =>
    import("../IdentityBindingsPanel").then(
      (module) => module.IdentityBindingsPanel,
    ),
  { loading: DeferredOverlayStatus },
);
const DeferredPasskeyPanel = dynamic(
  () => import("../PasskeyPanel").then((module) => module.PasskeyPanel),
  { loading: DeferredOverlayStatus },
);
const DeferredSessionPanel = dynamic(
  () => import("../SessionPanel").then((module) => module.SessionPanel),
  { loading: DeferredOverlayStatus },
);
const DeferredHostedStoreOnboarding = dynamic(
  () =>
    import("../HostedStoreOnboarding").then(
      (module) => module.HostedStoreOnboarding,
    ),
  { loading: DeferredOverlayStatus },
);

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
  storeConsoleSection: StoreConsoleSection;
  storeConsoleContext: StoreConsoleContext | null;
  setStoreConsoleContext: React.Dispatch<
    React.SetStateAction<StoreConsoleContext | null>
  >;
  canManageStoreConsole: boolean;
  ownedStores: StoreSummary[];
  setOwnedStores: React.Dispatch<React.SetStateAction<StoreSummary[]>>;
  ownedStoresError: string | null;
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
  storeConsoleSection,
  storeConsoleContext,
  setStoreConsoleContext,
  canManageStoreConsole,
  ownedStores,
  setOwnedStores,
  ownedStoresError,
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
  const [accountTask, setAccountTask] = useState<"security" | "appearance">(
    "security",
  );
  const [visitedAccountTasks, setVisitedAccountTasks] = useState<
    ReadonlySet<"security" | "appearance">
  >(() => new Set(["security"]));
  const selectedManagedStore = listing
    ? (ownedStores.find(
        (store) =>
          (listing.storeId && store.id === listing.storeId) ||
          store.path === listing.platformPath,
      ) ?? null)
    : null;

  const activateAccountTask = (task: "security" | "appearance") => {
    setVisitedAccountTasks((visited) =>
      visited.has(task) ? visited : new Set(visited).add(task),
    );
    setAccountTask(task);
  };

  return (
    <DeferredOverlayLocaleContext.Provider value={locale}>
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
          {storeConsoleOpen ? (
            <DeferredSubplatformAdminDashboard
              locale={locale}
              onNotice={setNotice}
              subplatform={storeConsoleContext.subplatform}
              store={storeConsoleContext.store}
              canManageStore={canManageStoreConsole}
              initialSection={storeConsoleSection}
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
          ) : null}
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
                ? `${ui.myStores}${ownedStoresResolved && !ownedStoresError ? ` · ${ownedStores.length}` : ""}`
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
              count:
                ownedStoresResolved && !ownedStoresError
                  ? ownedStores.length
                  : undefined,
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
              <Tabs
                value={accountTask}
                onValueChange={(value) =>
                  activateAccountTask(value as "security" | "appearance")
                }
                variant="pill"
                size="md"
                className="min-w-0"
              >
                <TabsList
                  aria-label={
                    locale === "en" ? "Account sections" : "账号二级分区"
                  }
                  className="w-full min-w-max overflow-x-auto"
                >
                  <TabsTrigger
                    id="workspace-account-security-tab"
                    value="security"
                    className="min-h-11"
                  >
                    {locale === "en" ? "Security" : "安全"}
                  </TabsTrigger>
                  <TabsTrigger
                    id="workspace-account-appearance-tab"
                    value="appearance"
                    className="min-h-11"
                  >
                    {locale === "en" ? "Appearance" : "外观"}
                  </TabsTrigger>
                </TabsList>
                {visitedAccountTasks.has("security") ? (
                  <TabsContent
                    id="workspace-account-security-panel"
                    value="security"
                    keepMounted
                  >
                    <DeferredChangePasswordPanel
                      email={authUser.email}
                      locale={locale}
                      onNotice={setNotice}
                    />
                    <DeferredIdentityBindingsPanel
                      locale={locale}
                      subplatform={subplatform}
                      onNotice={setNotice}
                    />
                    <DeferredPasskeyPanel
                      locale={locale}
                      subplatform={subplatform}
                      accountLabel={authUser.email}
                      onNotice={setNotice}
                    />
                    <DeferredSessionPanel
                      locale={locale}
                      subplatform={subplatform}
                      onNotice={setNotice}
                    />
                  </TabsContent>
                ) : null}
                {visitedAccountTasks.has("appearance") ? (
                  <TabsContent
                    id="workspace-account-appearance-panel"
                    value="appearance"
                    keepMounted
                  >
                    <section
                      className="workspace-settings-section"
                      aria-labelledby="workspace-preferences-title"
                    >
                      <div className="workspace-settings-section-heading">
                        <h3 id="workspace-preferences-title">
                          {locale === "en"
                            ? "Display and language"
                            : "显示与语言"}
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
                  </TabsContent>
                ) : null}
              </Tabs>
            </div>
          ) : accountSettingsSection === "stores" ? (
            <div className="workspace-settings-overview">
              <DeferredHostedStoreOnboarding
                locale={locale}
                onNotice={setNotice}
                initialStores={ownedStores}
                onStoresChange={setOwnedStores}
                onManageStore={(store) => void openStoreConsoleFor(store)}
              />
            </div>
          ) : accountSettingsSection === "profile" ? (
            <DeferredPersonalProfilePanel
              locale={locale}
              onAvatarChanged={(image) =>
                setAuthUser((current) =>
                  current ? { ...current, image } : current,
                )
              }
            />
          ) : null}
        </WorkspaceSettingsDialog>
      )}

      {listing ? (
        <DeferredListingSheet
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
      ) : null}

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
    </DeferredOverlayLocaleContext.Provider>
  );
}
