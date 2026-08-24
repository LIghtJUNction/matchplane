"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { spring } from "./components/Primitives";
import { PlatformDashboard } from "./components/PlatformDashboard";
import { PluginHost } from "./components/PluginHost";
import { MarketplaceHome } from "./components/MarketplaceHome";
import { PlatformFooter } from "./components/PlatformFooter";
import { StorefrontView } from "./components/StorefrontView";
import { PlatformHeader } from "./components/shell/PlatformHeader";
import { SubplatformFullscreenHeader } from "./components/shell/SubplatformFullscreenHeader";
import { PlatformOverlaysHost } from "./components/shell/PlatformOverlaysHost";

import {
  getPaymentSetting,
  isLiveMarketplaceEnabled,
  switchPaymentMode,
} from "./api";
import { useInterfacePreferences } from "./lib/preferences";
import { useMarketplaceCatalog } from "./hooks/useMarketplaceCatalog";
import { useAuthSession } from "./hooks/useAuthSession";
import {
  appCopy,
  useSubplatformRoute,
  type AccountSettingsSection,
} from "./hooks/useSubplatformRoute";
import { useOwnedStores } from "./hooks/useOwnedStores";
import { useStoreHandoff } from "./hooks/useStoreHandoff";

export function App({ initialPath = "/" }: { initialPath?: string }) {
  const { theme, locale, palette, setTheme, setLocale, setPalette } =
    useInterfacePreferences();
  const ui = appCopy(locale);
  const [notice, setNotice] = useState<string | null>(null);
  const [pluginFailed, setPluginFailed] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"test" | "production">("test");
  const [paymentModeVersion, setPaymentModeVersion] = useState(1);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);

  // Subplatform routing and URL sync
  const {
    role,
    setRole,
    subplatform,
    setSubplatform,
    hydrated,
    accountSettingsSection,
    setAccountSettingsSection,
    storeConsoleRequested,
    setStoreConsoleRequested,
    publishProductRequested,
    setPublishProductRequested,
    requestedRoleRef,
  } = useSubplatformRoute({ initialPath, authResolved: false });

  // Authentication session & authorization
  const { authUser, setAuthUser, authResolved, openSignIn, signOut } =
    useAuthSession({
      subplatform,
      requestedRoleRef,
      setRole,
      onNotice: setNotice,
    });

  // Re-sync subplatform route once auth resolves
  useEffect(() => {
    if (!hydrated || !authResolved) return;
    const searchParams = new URLSearchParams(window.location.search);
    if (role === "buyer") searchParams.delete("role");
    else searchParams.set("role", role);
    const query = searchParams.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, [authResolved, hydrated, role]);

  // Owned stores & store console
  const {
    ownedStores,
    setOwnedStores,
    ownedStoresResolved,
    storeConsoleOpen,
    setStoreConsoleOpen,
    storeConsoleContext,
    setStoreConsoleContext,
    currentManagedStore,
    canManageStoreConsole,
    openStoreConsoleFor,
    publishProduct,
  } = useOwnedStores({
    authUser,
    authResolved,
    subplatform,
    locale,
    storeConsoleRequested,
    setStoreConsoleRequested,
    publishProductRequested,
    setPublishProductRequested,
    setAccountSettingsSection,
    onNotice: setNotice,
    openSignIn,
  });

  // Marketplace catalog
  const {
    listings,
    catalogResolved,
    catalogError,
    retryCatalog,
    listing,
    setListing,
    closeListing,
    likeListing,
    replaceFromRecommendations,
  } = useMarketplaceCatalog({
    hydrated,
    locale,
    subplatform,
    authUserId: authUser?.id,
    onAuthRequired: () => openSignIn(role),
    onNotice: setNotice,
  });

  // Store AI handoff & contact consent
  const { requestStoreContactConsent, requestStoreAiHandoff, contactListing } =
    useStoreHandoff({
      subplatform,
      listings,
      locale,
      onNotice: setNotice,
    });

  // Auto-dismiss notice
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  // Reset plugin failure when subplatform switches
  useEffect(() => {
    setPluginFailed(false);
  }, [subplatform.path, subplatform.pluginArtifact?.url]);

  // Read payment settings in platform mode
  useEffect(() => {
    if (!hydrated || role !== "platform" || !isLiveMarketplaceEnabled()) return;
    void getPaymentSetting(subplatform.tenantId)
      .then((setting) => {
        setPaymentMode(setting.active_mode);
        setPaymentModeVersion(setting.version);
      })
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : "支付模式读取失败");
      });
  }, [hydrated, role, subplatform.tenantId]);

  const confirmModeChange = useCallback(() => {
    const nextMode = paymentMode === "test" ? "production" : "test";
    if (isLiveMarketplaceEnabled()) {
      void switchPaymentMode({
        tenantId: subplatform.tenantId,
        mode: nextMode,
        expectedVersion: paymentModeVersion,
        reason: `web-admin switch to ${nextMode}`,
      })
        .then((setting) => {
          setPaymentMode(setting.active_mode);
          setPaymentModeVersion(setting.version);
          setModeDialogOpen(false);
          setNotice(
            `支付系统已切换为${setting.active_mode === "test" ? "测试" : "生产"}模式`,
          );
        })
        .catch((error) => {
          setModeDialogOpen(false);
          setNotice(
            error instanceof Error ? error.message : "支付模式切换失败",
          );
        });
      return;
    }
    setPaymentMode(nextMode);
    setModeDialogOpen(false);
    setNotice(`支付系统已切换为${nextMode === "test" ? "测试" : "生产"}模式`);
  }, [paymentMode, paymentModeVersion, subplatform.tenantId]);

  const openStoreCenter = useCallback(() => {
    if (!authUser) {
      window.location.assign("/login?next=" + encodeURIComponent("/?stores=1"));
      return;
    }
    setAccountSettingsSection("stores");
  }, [authUser, setAccountSettingsSection]);

  const handleSignOut = useCallback(() => {
    void signOut(ui.signedOut, ui.signOutFailed);
    setAccountSettingsSection(null);
    setStoreConsoleOpen(false);
  }, [signOut, ui.signedOut, ui.signOutFailed, setAccountSettingsSection, setStoreConsoleOpen]);

  const genericWorkspace: ReactNode =
    role === "platform" ? (
      <PlatformDashboard
        paymentMode={paymentMode}
        rootRole={authUser?.role}
        onRequestModeChange={() => setModeDialogOpen(true)}
        onBrandUpdated={(brand) =>
          setSubplatform((current) =>
            current.slug === "root"
              ? {
                  ...current,
                  brandName: brand.name,
                  label: brand.name,
                  brandLogoUrl: brand.logoUrl ?? undefined,
                }
              : current,
          )
        }
        onNotice={setNotice}
      />
    ) : (
      <StorefrontView
        catalogResolved={catalogResolved}
        listings={listings}
        locale={locale}
        onOpenListing={setListing}
        onLikeListing={likeListing}
        onNotice={setNotice}
        onHumanHandoff={requestStoreAiHandoff}
        onContactConsent={requestStoreContactConsent}
        subplatform={subplatform}
        canManageStore={Boolean(currentManagedStore || canManageStoreConsole)}
        onOpenStoreConsole={() => {
          if (currentManagedStore) {
            setStoreConsoleContext({ subplatform, store: currentManagedStore });
            setStoreConsoleOpen(true);
          } else {
            setAccountSettingsSection("stores");
          }
        }}
      />
    );

  const fullscreenPlugin =
    subplatform.slug !== "root" &&
    Boolean(subplatform.pluginArtifact) &&
    !pluginFailed &&
    role === "platform" &&
    !storeConsoleOpen &&
    !storeConsoleRequested;

  const pluginWorkspace = subplatform.pluginArtifact ? (
    <PluginHost
      fullscreen={fullscreenPlugin}
      onFailure={() => setPluginFailed(true)}
      role={role}
      theme={theme}
      locale={locale}
      onNotice={setNotice}
      subplatform={subplatform}
      listings={listings}
      onOpenListing={setListing}
      fallback={genericWorkspace}
    />
  ) : null;

  return (
    <MotionConfig reducedMotion="user" transition={spring}>
      <div
        id="top"
        className={`app-shell retail-app-shell${fullscreenPlugin ? " is-subplatform-fullscreen" : ""}`}
        data-workspace={role}
        data-platform={subplatform.slug}
      >
        <a className="skip-link" href="#main-content">
          {ui.skipToContent}
        </a>

        {fullscreenPlugin ? (
          <SubplatformFullscreenHeader
            subplatform={subplatform}
            role={role}
            locale={locale}
            authUser={authUser}
            hasCurrentManagedStore={Boolean(currentManagedStore)}
            onManageStore={() => {
              if (currentManagedStore) {
                setStoreConsoleContext({
                  subplatform,
                  store: currentManagedStore,
                });
                setStoreConsoleOpen(true);
              }
            }}
            ui={{
              backToParent: ui.backToParent,
              manageStore: ui.manageStore,
            }}
          />
        ) : (
          <PlatformHeader
            subplatform={subplatform}
            role={role}
            theme={theme}
            locale={locale}
            palette={palette}
            onThemeChange={setTheme}
            onLocaleChange={setLocale}
            onPaletteChange={setPalette}
            authUser={authUser}
            authResolved={authResolved}
            ownedStoresCount={ownedStores.length}
            ownedStoresResolved={ownedStoresResolved}
            onOpenSignIn={() => openSignIn(role)}
            onOpenStoreCenter={openStoreCenter}
            onOpenAccountSection={(section: AccountSettingsSection) =>
              setAccountSettingsSection(section)
            }
            onSignOut={handleSignOut}
            ui={ui}
          />
        )}

        <main
          id="main-content"
          className={
            fullscreenPlugin ? "subplatform-fullscreen-main" : undefined
          }
          tabIndex={-1}
        >
          {fullscreenPlugin ? (
            pluginWorkspace
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={role}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={spring}
              >
                {role === "buyer" && subplatform.slug === "root" ? (
                  <MarketplaceHome
                    catalogResolved={catalogResolved}
                    catalogError={catalogError}
                    listings={listings}
                    onRetryCatalog={retryCatalog}
                    locale={locale}
                    theme={theme}
                    onLocaleChange={setLocale}
                    onThemeChange={setTheme}
                    onNotice={setNotice}
                    onOpenListing={setListing}
                    onLikeListing={likeListing}
                    onPublishProduct={publishProduct}
                    onRecommendations={replaceFromRecommendations}
                    subplatform={subplatform}
                  />
                ) : subplatform.pluginArtifact && role === "platform" ? (
                  pluginWorkspace
                ) : (
                  genericWorkspace
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </main>

        {fullscreenPlugin ? null : <PlatformFooter subplatform={subplatform} />}

        <PlatformOverlaysHost
          authUser={authUser}
          role={role}
          locale={locale}
          theme={theme}
          palette={palette}
          onThemeChange={setTheme}
          onLocaleChange={setLocale}
          onPaletteChange={setPalette}
          subplatform={subplatform}
          fullscreenPlugin={fullscreenPlugin}
          storeConsoleOpen={storeConsoleOpen}
          setStoreConsoleOpen={setStoreConsoleOpen}
          storeConsoleContext={storeConsoleContext}
          setStoreConsoleContext={setStoreConsoleContext}
          canManageStoreConsole={canManageStoreConsole}
          ownedStores={ownedStores}
          setOwnedStores={setOwnedStores}
          ownedStoresResolved={ownedStoresResolved}
          openStoreConsoleFor={openStoreConsoleFor}
          accountSettingsSection={accountSettingsSection}
          setAccountSettingsSection={setAccountSettingsSection}
          setAuthUser={setAuthUser}
          onSignOut={handleSignOut}
          listing={listing}
          closeListing={closeListing}
          onContactListing={contactListing}
          modeDialogOpen={modeDialogOpen}
          closeModeDialog={() => setModeDialogOpen(false)}
          paymentMode={paymentMode}
          confirmModeChange={confirmModeChange}
          notice={notice}
          setNotice={setNotice}
          ui={ui}
        />
      </div>
    </MotionConfig>
  );
}
