"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { spring } from "./components/Primitives";
import { FloatingMarketplaceClerk } from "./components/FloatingMarketplaceClerk";
import { MatchChat } from "./components/MatchChat";
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
  type MallAssistantSearchTrace,
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
import {
  clearPendingConversion,
  readPendingConversion,
} from "./pending-conversion";

const PlatformDashboardLocaleContext = createContext<"zh" | "en">("zh");

function PlatformDashboardLoading() {
  const locale = useContext(PlatformDashboardLocaleContext);
  const message =
    locale === "en" ? "Loading the mall console…" : "正在加载商城后台…";

  return (
    <section
      className="surface root-marketplace-loading-state"
      role="status"
      aria-label={message}
      aria-live="polite"
      aria-busy="true"
    >
      <p>{message}</p>
    </section>
  );
}

const PlatformDashboard = dynamic(
  () =>
    import("./components/PlatformDashboard").then(
      (module) => module.PlatformDashboard,
    ),
  { loading: PlatformDashboardLoading },
);

export function App({
  initialPath = "/",
  initialStoreName,
  initialStoreDescription,
}: {
  initialPath?: string;
  initialStoreName?: string;
  initialStoreDescription?: string;
}) {
  const {
    theme,
    locale,
    palette,
    textSize,
    setTheme,
    setLocale,
    setPalette,
    setTextSize,
  } = useInterfacePreferences();
  const ui = appCopy(locale);
  const [notice, setNotice] = useState<string | null>(null);
  const [pluginFailed, setPluginFailed] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"test" | "production">("test");
  const [paymentModeVersion, setPaymentModeVersion] = useState(1);
  const [paymentSettingStatus, setPaymentSettingStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const paymentSettingRequestRef = useRef(0);
  const paymentModeSwitchingRef = useRef(false);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [buyerAssistantOpen, setBuyerAssistantOpen] = useState(false);
  const [rootSearchTrace, setRootSearchTrace] =
    useState<MallAssistantSearchTrace | null>(null);
  const [webMcpDraftMessage, setWebMcpDraftMessage] = useState<string>();

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
    storeConsoleRequestedStoreId,
    setStoreConsoleRequestedStoreId,
    storeConsoleRequestedSection,
    navigateToSubplatform,
    requestedRoleRef,
  } = useSubplatformRoute({
    initialPath,
    initialStoreName,
    initialStoreDescription,
    authResolved: false,
  });

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
    if (subplatform.slug === "root") {
      setBuyerAssistantOpen(false);
    }
    if (subplatform.slug !== "root" || role !== "buyer")
      setRootSearchTrace(null);
  }, [role, subplatform.slug]);

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
    ownedStoresError,
    ownedStoresResolved,
    storeConsoleOpen,
    setStoreConsoleOpen,
    storeConsoleContext,
    setStoreConsoleContext,
    currentManagedStore,
    canManageStoreConsole,
    openStoreConsoleFor,
  } = useOwnedStores({
    authUser,
    subplatform,
    locale,
    storeConsoleRequested,
    setStoreConsoleRequested,
    storeConsoleRequestedStoreId,
    setStoreConsoleRequestedStoreId,
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
  const {
    requestStoreContactConsent,
    retrieveStoreContact,
    requestStoreAiHandoff,
    contactListing,
  } = useStoreHandoff({
    subplatform,
    listings,
    locale,
    onNotice: setNotice,
  });

  useEffect(() => {
    if (!authResolved || !authUser || !catalogResolved || listing) return;
    const pending = readPendingConversion();
    if (!pending || pending.storePath !== subplatform.path) return;
    const selected = listings.find(
      (candidate) =>
        candidate.offerId === pending.offerId ||
        candidate.id === pending.offerId,
    );
    if (!selected) {
      setNotice(
        catalogError
          ? locale === "en"
            ? "The saved request is still available. Catalog lookup failed temporarily; retry before submitting."
            : "已保留登录前的申请；目录暂时读取失败，请重试后再提交。"
          : locale === "en"
            ? "The saved listing is not in the current page. It will remain pending until a direct lookup confirms its status."
            : "已保留登录前的申请；当前页面未包含该商品，需单项查询确认状态后再恢复。",
      );
      return;
    }
    setListing(selected);
    setNotice(
      locale === "en"
        ? "Your saved request is ready. Review it before submitting."
        : "已恢复登录前的申请，请确认商品信息后再提交。",
    );
  }, [
    authResolved,
    authUser,
    catalogResolved,
    catalogError,
    listing,
    listings,
    locale,
    setListing,
    subplatform.path,
  ]);

  const closeListingAndCancelPending = useCallback(() => {
    clearPendingConversion(listing?.offerId ?? listing?.id);
    closeListing();
  }, [closeListing, listing]);

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

  // Read payment settings in platform mode. A tenant/role change invalidates late responses.
  useEffect(() => {
    const requestVersion = ++paymentSettingRequestRef.current;
    if (!hydrated || role !== "platform" || !isLiveMarketplaceEnabled()) {
      setPaymentSettingStatus("idle");
      return;
    }
    setPaymentSettingStatus("loading");
    void getPaymentSetting(subplatform.tenantId)
      .then((setting) => {
        if (paymentSettingRequestRef.current !== requestVersion) return;
        setPaymentMode(setting.active_mode);
        setPaymentModeVersion(setting.version);
        setPaymentSettingStatus("ready");
      })
      .catch((error) => {
        if (paymentSettingRequestRef.current !== requestVersion) return;
        setPaymentSettingStatus("error");
        setNotice(error instanceof Error ? error.message : "支付模式读取失败");
      });
    return () => {
      if (paymentSettingRequestRef.current === requestVersion) {
        paymentSettingRequestRef.current += 1;
      }
    };
  }, [hydrated, role, subplatform.tenantId]);

  const requestModeChange = useCallback(() => {
    if (isLiveMarketplaceEnabled() && paymentSettingStatus !== "ready") {
      setNotice(
        paymentSettingStatus === "loading"
          ? "支付模式正在读取，完成验证后再切换"
          : "支付模式尚未验证，请刷新后重试",
      );
      return;
    }
    setModeDialogOpen(true);
  }, [paymentSettingStatus]);

  const confirmModeChange = useCallback(() => {
    if (!isLiveMarketplaceEnabled()) {
      setModeDialogOpen(false);
      setNotice(
        locale === "en"
          ? "Payment mode was not saved because the platform API is disabled for this deployment. Enable it, refresh, and try again."
          : "支付模式未保存：当前部署未启用平台 API。启用后刷新页面再重试。",
      );
      return;
    }

    if (paymentSettingStatus !== "ready") {
      setModeDialogOpen(false);
      setNotice("支付模式尚未验证，请刷新后重试");
      return;
    }
    if (paymentModeSwitchingRef.current) return;
    paymentModeSwitchingRef.current = true;
    const switchRequestVersion = ++paymentSettingRequestRef.current;
    setPaymentSettingStatus("loading");

    const nextMode = paymentMode === "test" ? "production" : "test";
    void switchPaymentMode({
      tenantId: subplatform.tenantId,
      mode: nextMode,
      expectedVersion: paymentModeVersion,
      reason: `web-admin switch to ${nextMode}`,
    })
      .then((setting) => {
        if (paymentSettingRequestRef.current !== switchRequestVersion) return;
        setPaymentMode(setting.active_mode);
        setPaymentModeVersion(setting.version);
        setPaymentSettingStatus("ready");
        setModeDialogOpen(false);
        setNotice(
          `支付系统已切换为${setting.active_mode === "test" ? "测试" : "生产"}模式`,
        );
      })
      .catch((error) => {
        if (paymentSettingRequestRef.current !== switchRequestVersion) return;
        setPaymentSettingStatus("error");
        setModeDialogOpen(false);
        setNotice(error instanceof Error ? error.message : "支付模式切换失败");
      })
      .finally(() => {
        paymentModeSwitchingRef.current = false;
      });
  }, [
    locale,
    paymentMode,
    paymentModeVersion,
    paymentSettingStatus,
    subplatform.tenantId,
  ]);

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
  }, [
    signOut,
    ui.signedOut,
    ui.signOutFailed,
    setAccountSettingsSection,
    setStoreConsoleOpen,
  ]);

  const openMarketplaceListing = useCallback(
    (selected: (typeof listings)[number]) => {
      const targetPath = selected.platformPath;
      if (
        subplatform.slug === "root" &&
        targetPath &&
        targetPath !== subplatform.path
      ) {
        void navigateToSubplatform(targetPath).then(() => setListing(selected));
        return;
      }
      setListing(selected);
    },
    [
      listings,
      navigateToSubplatform,
      setListing,
      subplatform.path,
      subplatform.slug,
    ],
  );

  const openMarketplaceStore = useCallback(
    async (platformPath: string) => {
      await navigateToSubplatform(platformPath);
    },
    [navigateToSubplatform],
  );

  const describeMarketplaceNeed = useCallback((narrative: string) => {
    setWebMcpDraftMessage(narrative);
  }, []);

  const genericWorkspace: ReactNode =
    role === "platform" ? (
      <PlatformDashboardLocaleContext.Provider value={locale}>
        <PlatformDashboard
          paymentMode={paymentMode}
          rootRole={authUser?.role}
          onRequestModeChange={requestModeChange}
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
      </PlatformDashboardLocaleContext.Provider>
    ) : (
      <StorefrontView
        catalogResolved={catalogResolved}
        catalogError={catalogError}
        listings={listings}
        onRetryCatalog={retryCatalog}
        locale={locale}
        onOpenListing={setListing}
        onLikeListing={likeListing}
        onNotice={setNotice}
        onHumanHandoff={requestStoreAiHandoff}
        onContactConsent={requestStoreContactConsent}
        onContactRetrieve={retrieveStoreContact}
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
      onOpenListing={openMarketplaceListing}
      onLikeListing={likeListing}
      onOpenDemand={() => setBuyerAssistantOpen(true)}
      onAuthRequired={() => openSignIn(role)}
      authStatus={
        authResolved ? (authUser ? "authenticated" : "anonymous") : "pending"
      }
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
            textSize={textSize}
            onThemeChange={setTheme}
            onLocaleChange={setLocale}
            onPaletteChange={setPalette}
            onTextSizeChange={setTextSize}
            authUser={authUser}
            authResolved={authResolved}
            ownedStoresCount={ownedStores.length}
            ownedStoresError={ownedStoresError}
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
                    brandName={subplatform.brandName}
                    catalogResolved={catalogResolved}
                    catalogError={catalogError}
                    listings={listings}
                    onRetryCatalog={retryCatalog}
                    locale={locale}
                    assistant={
                      <MatchChat
                        home
                        role="buyer"
                        locale={locale}
                        onLikeListing={likeListing}
                        onNotice={setNotice}
                        onOpenListing={openMarketplaceListing}
                        onRecommendations={replaceFromRecommendations}
                        onSearchTrace={setRootSearchTrace}
                        onHumanHandoff={requestStoreAiHandoff}
                        onContactConsent={requestStoreContactConsent}
                        onContactRetrieve={retrieveStoreContact}
                        subplatform={subplatform}
                        draftMessage={webMcpDraftMessage}
                        onDraftMessageApplied={() =>
                          setWebMcpDraftMessage(undefined)
                        }
                      />
                    }
                    searchTrace={rootSearchTrace}
                    onWebMcpDescribeNeed={describeMarketplaceNeed}
                    onOpenStore={openMarketplaceStore}
                    onOpenListing={openMarketplaceListing}
                    onLikeListing={likeListing}
                  />
                ) : subplatform.pluginArtifact &&
                  (role === "platform" || role === "buyer") ? (
                  <>
                    {pluginWorkspace}
                    {role === "buyer" ? (
                      <FloatingMarketplaceClerk
                        open={buyerAssistantOpen}
                        locale={locale}
                        launcherLabel={
                          locale === "en" ? "Describe your need" : "说需求"
                        }
                        onOpenChange={setBuyerAssistantOpen}
                      >
                        <div className="root-marketplace-chat-shell">
                          <MatchChat
                            compact
                            role="buyer"
                            locale={locale}
                            onLikeListing={likeListing}
                            onNotice={setNotice}
                            onOpenListing={openMarketplaceListing}
                            onRecommendations={replaceFromRecommendations}
                            onHumanHandoff={requestStoreAiHandoff}
                            onContactConsent={requestStoreContactConsent}
                            onContactRetrieve={retrieveStoreContact}
                            subplatform={subplatform}
                          />
                        </div>
                      </FloatingMarketplaceClerk>
                    ) : null}
                  </>
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
          textSize={textSize}
          onThemeChange={setTheme}
          onLocaleChange={setLocale}
          onPaletteChange={setPalette}
          onTextSizeChange={setTextSize}
          subplatform={subplatform}
          fullscreenPlugin={fullscreenPlugin}
          storeConsoleOpen={storeConsoleOpen}
          setStoreConsoleOpen={setStoreConsoleOpen}
          storeConsoleSection={storeConsoleRequestedSection}
          storeConsoleContext={storeConsoleContext}
          setStoreConsoleContext={setStoreConsoleContext}
          canManageStoreConsole={canManageStoreConsole}
          ownedStores={ownedStores}
          setOwnedStores={setOwnedStores}
          ownedStoresError={ownedStoresError}
          ownedStoresResolved={ownedStoresResolved}
          openStoreConsoleFor={openStoreConsoleFor}
          accountSettingsSection={accountSettingsSection}
          setAccountSettingsSection={setAccountSettingsSection}
          setAuthUser={setAuthUser}
          onSignOut={handleSignOut}
          listing={listing}
          closeListing={closeListingAndCancelPending}
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
