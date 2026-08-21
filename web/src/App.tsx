"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  LogIn,
  LogOut,
  Settings2,
  UserRound,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { BuyerDashboard } from "./components/BuyerDashboard";
import { ContactProfileCard } from "./components/ContactProfileCard";
import { ListingSheet, ModeDialog } from "./components/Overlays";
import { PlatformDashboard } from "./components/PlatformDashboard";
import { PreferenceControls } from "./components/PreferenceControls";
import { Brand, spring } from "./components/Primitives";
import { SellerDashboard } from "./components/SellerDashboard";
import { SubplatformAdminDashboard } from "./components/SubplatformAdminDashboard";
import { PluginHost } from "./components/PluginHost";
import { MatchChat } from "./components/MatchChat";
import { IdentityBindingsPanel } from "./components/IdentityBindingsPanel";
import { PasskeyPanel } from "./components/PasskeyPanel";
import { SessionPanel } from "./components/SessionPanel";
import { PersonalProfilePanel } from "./components/PersonalProfilePanel";
import { PlatformFooter } from "./components/PlatformFooter";
import { PlatformMenu } from "./components/PlatformMenu";
import { StorefrontDirectory } from "./components/StorefrontDirectory";
import { HostedStoreOnboarding } from "./components/HostedStoreOnboarding";
import { WorkspaceSettingsDialog } from "./components/WorkspaceSettingsDialog";
import { loadSubplatform, resolveSubplatform, subplatformCopy, subplatformFieldLabel, type SubplatformConfig } from "./subplatform";
import { localizedSubplatformCopy } from "./lib/localized-copy";
import {
  createMarketplaceIntroduction,
  createMarketplaceIntent,
  createMarketplaceSalesHandoff,
  getMarketplaceProfile,
  requestMarketplaceContact,
  createBuyerIntroduction,
  clearPartySessionCache,
  getPaymentSetting,
  type RecommendedBackendListing,
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  switchPaymentMode,
} from "./api";
import { getMarketplaceSession } from "./lib/marketplace-session";
import { authClient, authFetchOptions } from "./lib/auth-client";
import { useInterfacePreferences } from "./lib/preferences";
import type { AssetListing, WorkspaceRole } from "./types";

interface AuthenticatedUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
}

export function App({ initialPath = "/" }: { initialPath?: string }) {
  const { theme, locale, setTheme, setLocale } = useInterfacePreferences();
  const ui = appCopy(locale);
  const [role, setRole] = useState<WorkspaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() => resolveSubplatform(initialPath));
  const [listings, setListings] = useState<AssetListing[]>([]);
  const [listing, setListing] = useState<AssetListing | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"test" | "production">("test");
  const [paymentModeVersion, setPaymentModeVersion] = useState(1);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [pluginFailed, setPluginFailed] = useState(false);
  // Keep the requested destination independent from the URL that hydration normalizes to the
  // safe buyer surface. Otherwise `?role=platform` can be overwritten before Better Auth
  // resolves, which silently strands a valid administrator in the buyer workspace.
  const requestedRoleRef = useRef<WorkspaceRole>(roleFromLocation());

  useEffect(() => {
    setPluginFailed(false);
  }, [subplatform.path, subplatform.pluginArtifact?.url]);

  const closeListing = useCallback(() => setListing(null), []);
  const closeModeDialog = useCallback(() => setModeDialogOpen(false), []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const requestedPath = window.location.pathname;
    const url = new URL(window.location.href);
    const accountTarget = url.searchParams.get("account");
    let cleanWorkspaceTarget = false;
    if (accountTarget === "identity") {
      setAccountOpen(true);
      url.searchParams.delete("account");
      cleanWorkspaceTarget = true;
    }
    if (accountTarget === "profile") {
      setProfileOpen(true);
      url.searchParams.delete("account");
      cleanWorkspaceTarget = true;
    }
    if (url.searchParams.get("console") === "products") {
      setSettingsOpen(true);
      url.searchParams.delete("console");
      cleanWorkspaceTarget = true;
    }
    if (cleanWorkspaceTarget) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setSubplatform(resolveSubplatform(requestedPath));
    void loadSubplatform(requestedPath).then(setSubplatform);
    const requestedRole = roleFromLocation();
    requestedRoleRef.current = requestedRole;
    // Never render a privileged or supply workspace while the Better Auth
    // session check is still pending. The authenticated effect below restores
    // the requested role only after a real session is available.
    setRole(requiresAuthenticatedWorkspace(requestedRole) ? "buyer" : requestedRole);
    setListing(listingFromLocation());
    setHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A session is cookie-backed and therefore arrives asynchronously after a
    // hard refresh. Keep the header neutral until that check has completed;
    // also discard an older request when a subplatform transition starts a
    // newer one, so a late failure cannot briefly replace a valid session.
    setAuthResolved(false);
    void authClient
      .getSession({ fetchOptions: authFetchOptions(subplatform.slug) })
      .then(({ data }) => {
        if (cancelled) return;
        const user = data?.user as AuthenticatedUser | undefined;
        setAuthUser(user?.id ? user : null);
        setAuthResolved(true);
        const requestedRole = requestedRoleRef.current;
        const userRole = user?.role;
        const isRootManager = userRole === "rootSuperAdmin" || userRole === "rootAdmin";
        if (requiresAuthenticatedWorkspace(requestedRole) && !user) {
          setRole("buyer");
          window.location.assign(loginHref(requestedRole));
          return;
        }
        if (requestedRole === "platform" && !isRootManager) {
          setRole("buyer");
          setNotice("当前账号没有商城运营权限");
          return;
        }
        if (user && requiresAuthenticatedWorkspace(requestedRole)) {
          setRole(requestedRole);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAuthUser(null);
        setAuthResolved(true);
        const requestedRole = requestedRoleRef.current;
        if (requiresAuthenticatedWorkspace(requestedRole)) {
          setRole("buyer");
          window.location.assign(loginHref(requestedRole));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [subplatform.slug]);

  const openSignIn = () => {
    window.location.assign(loginHref(role));
  };

  const signOut = async () => {
    try {
      const result = await authClient.signOut({ fetchOptions: authFetchOptions(subplatform.slug) });
      if (result.error) throw new Error(result.error.message || "退出登录失败");
      clearPartySessionCache();
      setAuthUser(null);
      setSettingsOpen(false);
      setAccountOpen(false);
      setProfileOpen(false);
      setAccountMenuOpen(false);
      setRole("buyer");
      requestedRoleRef.current = "buyer";
      const url = new URL(window.location.href);
      url.searchParams.delete("role");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      setNotice(ui.signedOut);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : ui.signOutFailed);
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    const url = new URL(window.location.href);
    if (role === "buyer") url.searchParams.delete("role");
    else url.searchParams.set("role", role);
    window.history.replaceState(null, "", url);
  }, [hydrated, role]);

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

  const confirmModeChange = () => {
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
          setNotice(`支付系统已切换为${setting.active_mode === "test" ? "测试" : "生产"}模式`);
        })
        .catch((error) => {
          setModeDialogOpen(false);
          setNotice(error instanceof Error ? error.message : "支付模式切换失败");
        });
      return;
    }
    setPaymentMode(nextMode);
    setModeDialogOpen(false);
    setNotice(`支付系统已切换为${nextMode === "test" ? "测试" : "生产"}模式`);
  };

  const genericWorkspace: ReactNode = role === "subplatform_admin" ? (
    <SubplatformAdminDashboard onNotice={setNotice} subplatform={subplatform} />
  ) : role === "platform" ? (
    <PlatformDashboard
      paymentMode={paymentMode}
      rootRole={authUser?.role}
      onRequestModeChange={() => setModeDialogOpen(true)}
      onBrandUpdated={(brand) => setSubplatform((current) => current.slug === "root"
        ? { ...current, brandName: brand.name, label: brand.name, brandLogoUrl: brand.logoUrl ?? undefined }
        : current)}
      onNotice={setNotice}
    />
  ) : (
    <BuyerDashboard listings={listings} locale={locale} onOpenListing={setListing} onNotice={setNotice} subplatform={subplatform} />
  );
  const fullscreenPlugin = subplatform.slug !== "root"
    && Boolean(subplatform.pluginArtifact)
    && !pluginFailed
    && role === "buyer";
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
      <div id="top" className={`app-shell${fullscreenPlugin ? " is-subplatform-fullscreen" : ""}`}>
        <a className="skip-link" href="#main-content">{ui.skipToContent}</a>
        {fullscreenPlugin ? (
          <header className="subplatform-fullscreen-header">
            <a
              className="subplatform-back-link"
              href={parentPlatformHref(subplatform.path, role)}
              aria-label={ui.backToParent}
              title={ui.backToParent}
            >
              <ChevronLeft size={25} strokeWidth={1.75} aria-hidden="true" />
            </a>
          </header>
        ) : (
          <header className="app-header">
            <div className="header-inner">
              <div className="brand-cluster">
                <Brand
                  label={subplatform.brandName}
                  logoUrl={subplatform.slug === "root" ? subplatform.brandLogoUrl : undefined}
                  homeHref={subplatform.slug === "root" ? "#top" : subplatform.path}
                />
                {subplatform.slug === "root" ? <PlatformMenu locale={locale} /> : null}
                {subplatform.slug !== "root" ? <a className="root-platform-link" href="/">{ui.rootPlatform}</a> : null}
              </div>
              <div className="header-actions">
                <PreferenceControls theme={theme} locale={locale} onThemeChange={setTheme} onLocaleChange={setLocale} />
                {!authUser && authResolved ? (
                  <motion.button
                    className="header-signin-action"
                    type="button"
                    onClick={() => openSignIn()}
                    whileTap={{ scale: 0.97 }}
                    transition={spring}
                  >
                    <LogIn size={17} aria-hidden="true" />
                    <span>{ui.signIn}</span>
                  </motion.button>
                ) : null}
                {authUser?.role === "rootSuperAdmin" || authUser?.role === "rootAdmin" ? (
                  <a className="header-admin-action" href="/?role=platform">
                    <UserRound size={17} aria-hidden="true" />
                    <span>{ui.platformAdmin}</span>
                  </a>
                ) : null}
                {authUser ? (
                  <div className="account-menu-anchor">
                    <motion.button
                      className="profile-button"
                      type="button"
                      aria-expanded={accountMenuOpen}
                      aria-haspopup="menu"
                      aria-label={ui.accountMenu}
                      onClick={() => setAccountMenuOpen((open) => !open)}
                      whileTap={{ scale: 0.95 }}
                      transition={spring}
                    >
                      <span className="profile-button-avatar">{authUser.image ? <img src={authUser.image} alt="" /> : <UserRound size={18} aria-hidden="true" />}</span>
                      <span className="profile-copy"><strong>{authUser.name || ui.user}</strong><small>{roleLabel(role, locale, subplatform)}</small></span>
                    </motion.button>
                    {accountMenuOpen ? (
                      <div className="account-menu" role="menu" aria-label={ui.accountMenu}>
                        <div className="account-menu-identity"><strong>{authUser.name || ui.user}</strong><small>{authUser.email || ui.unifiedIdentity}</small></div>
                        <div className="account-menu-links">
                          <button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); setProfileOpen(true); }}><UserRound size={16} aria-hidden="true" />{ui.profile}</button>
                          <button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); setAccountOpen(true); }}><UserRound size={16} aria-hidden="true" />{ui.account}</button>
                          <button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); }}><Settings2 size={16} aria-hidden="true" />{ui.console}</button>
                        </div>
                        <button className="account-menu-signout" type="button" role="menuitem" onClick={() => void signOut()}><LogOut size={16} aria-hidden="true" />{ui.signOut}</button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </header>
        )}

        <main id="main-content" className={fullscreenPlugin ? "subplatform-fullscreen-main" : undefined} tabIndex={-1}>
          {fullscreenPlugin ? pluginWorkspace : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={role}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={spring}
              >
                {role === "buyer" ? (
                  subplatform.slug === "root" && listings.length === 0 ? (
                    <div className="mall-browse-scene">
                      <StorefrontDirectory locale={locale} mallName={subplatform.brandName} />
                      <MatchChat
                        role={role}
                        locale={locale}
                        onNotice={setNotice}
                        onRecommendations={(recommendations) => setListings(mapRecommendations(recommendations, subplatform, locale))}
                        subplatform={subplatform}
                      />
                    </div>
                  ) : (
                    <MatchChat
                      role={role}
                      locale={locale}
                      onNotice={setNotice}
                      onRecommendations={(recommendations) => setListings(mapRecommendations(recommendations, subplatform, locale))}
                      subplatform={subplatform}
                    />
                  )
                ) : null}
                {subplatform.pluginArtifact && (role === "platform" || role === "subplatform_admin" || (role === "buyer" && listings.length > 0))
                  ? pluginWorkspace
                  : genericWorkspace}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
        {fullscreenPlugin ? null : <PlatformFooter subplatform={subplatform} />}

        {!authUser ? null : <WorkspaceSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title={ui.console}
          description={ui.consoleDescription}
          className="workspace-settings-dialog-wide"
          closeLabel={ui.closeConsole}
          backdropLabel={ui.closeConsoleDialog}
        >
          <div className="workspace-settings-overview">
            {subplatform.slug === "root" ? (
              <HostedStoreOnboarding locale={locale} onNotice={setNotice} />
            ) : (
              <>
                <ContactProfileCard locale={locale} subplatform={subplatform} role="buyer" onNotice={setNotice} />
                <SellerDashboard locale={locale} onNotice={setNotice} subplatform={subplatform} />
              </>
            )}
          </div>
        </WorkspaceSettingsDialog>}

        {fullscreenPlugin || !authUser ? null : <WorkspaceSettingsDialog
          open={profileOpen}
          onClose={() => setProfileOpen(false)}
          title={ui.profile}
          description={ui.profileDescription}
          closeLabel={ui.closeProfile}
          backdropLabel={ui.closeProfileDialog}
        >
          <PersonalProfilePanel
            onNotice={setNotice}
            onAvatarChanged={(image) => setAuthUser((current) => current ? { ...current, image } : current)}
          />
        </WorkspaceSettingsDialog>}

        {fullscreenPlugin || !authUser ? null : <WorkspaceSettingsDialog
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          title={ui.account}
          description={ui.accountDescription}
          closeLabel={ui.closeAccount}
          backdropLabel={ui.closeAccountDialog}
        >
          <div className="workspace-settings-overview">
            <section className="workspace-settings-section workspace-account-section" aria-labelledby="workspace-account-title">
              <div className="workspace-settings-section-heading">
                <h3 id="workspace-account-title">{ui.account}</h3>
                <span>{roleLabel(role, locale, subplatform)}</span>
              </div>
              <div className="workspace-account-row">
                <span className="workspace-account-avatar">{authUser.image ? <img src={authUser.image} alt="" /> : <UserRound size={19} aria-hidden="true" />}</span>
                <span className="workspace-account-copy"><strong>{authUser.name || ui.user}</strong><small>{authUser.email || ui.unifiedIdentity}</small></span>
                <button className="workspace-account-action" type="button" onClick={() => void signOut()}><LogOut size={16} aria-hidden="true" />{ui.signOut}</button>
              </div>
            </section>
            <PasskeyPanel locale={locale} subplatform={subplatform} accountLabel={authUser.email} onNotice={setNotice} />
            <IdentityBindingsPanel locale={locale} subplatform={subplatform} onNotice={setNotice} />
            <SessionPanel locale={locale} subplatform={subplatform} onNotice={setNotice} />
          </div>
        </WorkspaceSettingsDialog>}

        <ListingSheet
          listing={listing}
          subplatform={subplatform}
          locale={locale}
          onClose={closeListing}
          contactDisabled={!isLiveMarketplaceEnabled()}
          onContact={async (selected) => {
            const selectedPath = selected.platformPath || subplatform.path;
            const selectedSubplatform = selectedPath !== subplatform.path && selected.subplatform
              ? {
                  ...(await loadSubplatform(selectedPath)),
                  path: selectedPath,
                  slug: selected.subplatform,
                  ...(selected.tenantId ? { tenantId: selected.tenantId } : {}),
                  ...(selected.domainId ? { domainId: selected.domainId } : {}),
                }
              : subplatform;
            const selectedTenantId = selected.tenantId || selectedSubplatform.tenantId;
            const selectedDomainId = selected.domainId || selectedSubplatform.domainId;
            if (!isLiveMarketplaceEnabled()) {
              setNotice("当前环境未连接真实撮合 API，未发送联系申请");
              return;
            }
            const isGenericOffer = Boolean(selected.offerId);
            const listingId = isGenericOffer ? null : listingIdFromBackend(selected);
            if (!isGenericOffer && !listingId) {
              setNotice("商品必须来自已接入店铺的真实目录；当前未发送申请");
              return;
            }
            if (!selectedDomainId || (!isGenericOffer && !selectedSubplatform.currency)) {
              setNotice("当前店铺尚未完成身份与价格配置；当前未发送申请");
              return;
            }
            try {
              const session = await getMarketplaceSession({
                subplatform: selectedSubplatform.slug,
                platformPath: selectedPath,
                tenantId: selectedTenantId,
                domainId: selectedDomainId,
                role: "buyer",
              });
              if (!session) {
                const next = `${window.location.pathname}${window.location.search}`;
                window.location.assign(`/login?next=${encodeURIComponent(next)}`);
                return;
              }
              if (isGenericOffer && selected.offerId) {
                const selectedIntentId = selected.intentId ?? (await createMarketplaceIntent({
                  session,
                  domainId: selectedDomainId,
                  side: "demand",
                  narrative: `我想进一步了解并购买“${selected.title}”`,
                  attributes: {
                    source: "public_storefront",
                    offer_id: selected.offerId,
                    platform_path: selectedPath,
                  },
                  supplyDiscoveryEnabled: false,
                  idempotencyKey: `public-offer-${selected.offerId}`,
                })).intent_id;
                const profile = await getMarketplaceProfile({
                  session,
                  domainId: selectedDomainId,
                }).catch(() => null);
                try {
                  await createMarketplaceSalesHandoff({
                    session,
                    domainId: selectedDomainId,
                    intentId: selectedIntentId,
                    summary: {
                      source: "buyer_contact_request",
                      offer_id: selected.offerId,
                      offer_title: selected.title,
                      platform_path: selectedPath,
                      profile: profile?.profile ?? null,
                      match_level: selected.matchScore === undefined
                        ? null
                        : selected.matchScore >= 80 ? "very_suitable" : selected.matchScore >= 60 ? "suitable" : selected.matchScore >= 40 ? "possible" : "weak",
                      reasons: selected.reasons ?? [],
                      risks: selected.risks ?? [],
                      recent_offer_ids: listings.filter((item) => item.platformPath === selectedPath).map((item) => item.offerId ?? item.id).slice(0, 32),
                      saved_offer_ids: readSavedOfferIds(selectedPath),
                    },
                    idempotencyKey: `web-handoff-${selectedIntentId}-${selected.offerId}`,
                  });
                } catch {
                  // A missing optional handoff migration must not prevent a consent-gated contact request.
                }
                const introduction = await createMarketplaceIntroduction({
                  session,
                  domainId: selectedDomainId,
                  intentId: selectedIntentId,
                  offerId: selected.offerId,
                  score: (selected.matchScore ?? 0) / 100,
                  idempotencyKey: `web-introduction-${Date.now()}`,
                });
                const introductionId = typeof introduction.introduction_id === "string"
                  ? introduction.introduction_id
                  : null;
                if (!introductionId) throw new Error("撮合结果缺少介绍编号，未发送联系申请");
                await requestMarketplaceContact({
                  session,
                  domainId: selectedDomainId,
                  introductionId,
                });
              } else if (listingId && selectedSubplatform.currency) {
                await createBuyerIntroduction({
                  session,
                  domainId: selectedDomainId,
                  listingId,
                  narrative: subplatformCopy(selectedSubplatform, "contactIntentNarrative", "希望与供给方直接沟通并完成后续协商"),
                  requirements: {},
                  currency: selectedSubplatform.currency,
                  currencyScale: selectedSubplatform.currencyScale ?? 0,
                  exposureKey: `web-contact-${Date.now()}`,
                });
              }
              closeListing();
              window.dispatchEvent(new Event("matchplane.contact.updated"));
              setNotice("联系申请已写入撮合系统，等待供给方明确同意后交换联系方式");
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "联系申请未发送，请稍后重试");
            }
          }}
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
              className="toast"
              role="status"
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={spring}
            >
              {notice}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

function roleFromLocation(): WorkspaceRole {
  if (typeof window === "undefined") return "buyer";
  const requested = new URLSearchParams(window.location.search).get("role");
  return requested === "platform" || requested === "subplatform_admin" ? requested : "buyer";
}

/** Administration is authenticated; the public matching conversation remains available to visitors. */
function requiresAuthenticatedWorkspace(role: WorkspaceRole): boolean {
  return role === "platform" || role === "subplatform_admin";
}

/** Keep the intended workspace through Better Auth without trusting an external redirect. */
function loginHref(role: WorkspaceRole): string {
  if (typeof window === "undefined") return `/login?role=${encodeURIComponent(role)}`;
  const current = new URL(window.location.href);
  current.searchParams.set("role", role);
  const next = `${current.pathname}${current.search}${current.hash}`;
  return `/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`;
}

function parentPlatformHref(path: string, role: WorkspaceRole): string {
  void path;
  return role === "buyer" ? "/" : `/?role=${encodeURIComponent(role)}`;
}

function roleLabel(role: WorkspaceRole, locale: "zh" | "en", subplatform: SubplatformConfig): string {
  if (locale === "en") {
    return role === "buyer"
      ? "Account"
      : role === "subplatform_admin"
          ? subplatformCopy(subplatform, "subplatformAdminLabelEn", "Store operator")
          : subplatformCopy(subplatform, "platformAdminLabelEn", "Mall operator");
  }
  return role === "buyer"
    ? "统一账号"
    : role === "subplatform_admin"
        ? subplatformCopy(subplatform, "subplatformAdminLabel", "店铺运营")
        : subplatformCopy(subplatform, "platformAdminLabel", "商城运营");
}

function appCopy(locale: "zh" | "en") {
  if (locale === "en") {
    return {
      skipToContent: "Skip to content",
      backToParent: "Back to mall",
      rootPlatform: "Mall",
      console: "Console",
      consoleDescription: "Manage your requests, listings, and contact details.",
      closeConsole: "Close console",
      closeConsoleDialog: "Close console dialog",
      account: "Account",
      accountMenu: "Account menu",
      accountDescription: "Manage your account identity and sign out.",
      profile: "Profile",
      profileDescription: "Choose your avatar and introduce yourself.",
      closeProfile: "Close profile",
      closeProfileDialog: "Close profile dialog",
      closeAccount: "Close account",
      closeAccountDialog: "Close account dialog",
      appearance: "Display & language",
      workspace: "Workspace",
      signIn: "Sign in",
      user: "MatchPlane user",
      unifiedIdentity: "Unified identity",
      subplatformAdmin: "Store console",
      platformAdmin: "Mall console",
      signOut: "Sign out",
      signedOut: "Signed out",
      signOutFailed: "Could not sign out. Try again.",
    };
  }
  return {
    skipToContent: "跳到主要内容",
    backToParent: "返回商城",
    rootPlatform: "商城首页",
    console: "控制台",
    consoleDescription: "管理你的需求、商品和联系方式。",
    closeConsole: "关闭控制台",
    closeConsoleDialog: "关闭控制台对话框",
    account: "账号",
    accountMenu: "账号菜单",
    accountDescription: "管理当前账号与登录状态。",
    profile: "个人资料",
    profileDescription: "设置头像和个人简介。",
    closeProfile: "关闭个人资料",
    closeProfileDialog: "关闭个人资料对话框",
    closeAccount: "关闭账号",
    closeAccountDialog: "关闭账号对话框",
    appearance: "显示与语言",
    workspace: "工作台",
    signIn: "登录",
    user: "MatchPlane 用户",
    unifiedIdentity: "已登录的统一身份",
    subplatformAdmin: "店铺控制台",
    platformAdmin: "商城控制台",
    signOut: "退出登录",
    signedOut: "已退出当前账号",
    signOutFailed: "退出登录失败，请稍后重试",
  };
}

function listingFromLocation(): AssetListing | null {
  // Listings are loaded from the root API/subplatform adapter. Never hydrate a fabricated
  // inventory item from a URL parameter.
  return null;
}

function readSavedOfferIds(platformPath: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(`matchplane.saved.${platformPath}`) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, 32)
      : [];
  } catch {
    return [];
  }
}

function mapRecommendations(items: RecommendedBackendListing[], subplatform: SubplatformConfig, locale: "zh" | "en"): AssetListing[] {
  return items.flatMap((item, index) => {
    const id = item.listing_id ?? item.offer_id;
    if (!id) return [];
    const attributes = item.attributes && typeof item.attributes === "object" && !Array.isArray(item.attributes)
      ? item.attributes
      : {};
    const configuredLabels = item.field_labels && typeof item.field_labels === "object" && !Array.isArray(item.field_labels)
      ? item.field_labels as Record<string, unknown>
      : {};
    const facts = Object.entries(attributes)
      .filter(([key]) => key !== "description" && key !== "attachments")
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 4)
      .map(([label, value]) => ({
        label: typeof configuredLabels[label] === "string" && configuredLabels[label].trim()
          ? configuredLabels[label] as string
          : subplatformFieldLabel(subplatform, label),
        key: label,
        value: String(value),
      }));
    const storeName = typeof item.store_name === "string" && item.store_name.trim() ? item.store_name.trim() : undefined;
    const subtitle = storeName ?? facts.slice(0, 2).map((fact) => `${fact.label} ${fact.value}`).join(" · ");
    const description = typeof attributes.description === "string" && attributes.description.trim()
      ? attributes.description.trim()
      : undefined;
    const imageUrl = typeof item.image_url === "string" && item.image_url.trim() ? item.image_url.trim() : undefined;
    const location = typeof item.location === "string" && item.location.trim() ? item.location.trim() : undefined;
    const terms = item.terms && typeof item.terms === "object" && !Array.isArray(item.terms) ? item.terms : {};
    const currencyScale = item.currency_scale;
    const termAmount = typeof terms.amount_minor === "string" ? terms.amount_minor : undefined;
    const termAmountMin = typeof terms.amount_min_minor === "string" ? terms.amount_min_minor : undefined;
    const termAmountMax = typeof terms.amount_max_minor === "string" ? terms.amount_max_minor : undefined;
    const termCurrency = typeof terms.currency === "string" ? terms.currency : undefined;
    const termScale = typeof terms.currency_scale === "number" && Number.isInteger(terms.currency_scale)
      ? terms.currency_scale
      : undefined;
    const termPriceRange = termAmountMin && termAmountMax && termCurrency && termScale !== undefined
      ? `${formatMoney(termAmountMin, termCurrency, termScale)} – ${formatMoney(termAmountMax, termCurrency, termScale)}`
      : undefined;
    const pricingMode = typeof terms.pricing_mode === "string" ? terms.pricing_mode : undefined;
    const pricingNote = stringAttribute(terms, ["pricing_note", "pricing_label"]);
    const price = item.asking_amount && item.currency && typeof currencyScale === "number" && Number.isInteger(currencyScale)
      ? formatMoney(item.asking_amount, item.currency, currencyScale)
      : termAmount && termCurrency && termScale !== undefined
        ? formatMoney(termAmount, termCurrency, termScale)
        : termPriceRange
          ? termPriceRange
          : pricingMode === "negotiable"
            ? pricingNote ?? localizedSubplatformCopy(subplatform, locale, "negotiablePriceLabel", "可议价", "Negotiable")
            : pricingMode === "none"
              ? pricingNote ?? localizedSubplatformCopy(subplatform, locale, "noPriceLabel", "面议", "Price on request")
              : stringAttribute(terms, ["display_price", "price_label", "price"]) ?? "—";
    return [{
      id,
      tenantId: item.tenant_id,
      domainId: item.domain_id,
      platformPath: typeof item.platform_path === "string" ? item.platform_path : subplatform.path,
      subplatform: typeof item.subplatform === "string" ? item.subplatform : subplatform.slug,
      title: item.display_name,
      subtitle,
      description,
      imageUrl,
      storeName,
      price,
      ...(termAmount && termCurrency && termScale !== undefined ? {
        priceAmountMinor: termAmount,
        priceCurrency: termCurrency,
        priceCurrencyScale: termScale,
      } : item.asking_amount && item.currency && typeof currencyScale === "number" && Number.isInteger(currencyScale) ? {
        priceAmountMinor: item.asking_amount,
        priceCurrency: item.currency,
        priceCurrencyScale: currencyScale,
      } : {}),
      location,
      matchScore: Math.round(Math.max(0, Math.min(1, item.match_score ?? 0)) * 100),
      accent: (["cactus", "clay", "heather", "oat"] as const)[index % 4],
      facts,
      reasons: item.match_reasons ?? (typeof item.reasons === "object" && Array.isArray(item.reasons) ? item.reasons.filter((reason): reason is string => typeof reason === "string") : undefined),
      risks: item.match_risks ?? (typeof item.risks === "object" && Array.isArray(item.risks) ? item.risks.filter((risk): risk is string => typeof risk === "string") : undefined),
      trust: stringArrayAttribute(item, ["trust", "verification_labels", "verificationLabels"]),
      seller: storeName,
      response: stringAttribute(item, ["response", "seller_response", "sellerResponse"]),
      offerId: item.offer_id,
      intentId: typeof item.intent_id === "string" ? item.intent_id : undefined,
    }];
  });
}

function stringAttribute(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

function stringArrayAttribute(value: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      const items = candidate.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
      if (items.length) return items.slice(0, 8);
    }
  }
  return undefined;
}

function formatMoney(amount: string, currency: string, scale: number): string {
  try {
    const numeric = BigInt(amount);
    const divisor = 10n ** BigInt(Math.max(0, scale));
    const whole = numeric / divisor;
    const remainder = (numeric < 0n ? -numeric : numeric) % divisor;
    if (scale === 0) return `${currency} ${whole}`;
    return `${currency} ${whole}.${remainder.toString().padStart(scale, "0")}`;
  } catch {
    return `${currency} ${amount}`;
  }
}
