"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Bell,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { BuyerDashboard } from "./components/BuyerDashboard";
import { ListingSheet, ModeDialog } from "./components/Overlays";
import { PlatformDashboard } from "./components/PlatformDashboard";
import { PreferenceControls } from "./components/PreferenceControls";
import { Brand, IconButton, spring } from "./components/Primitives";
import { SellerDashboard } from "./components/SellerDashboard";
import { SubplatformAdminDashboard } from "./components/SubplatformAdminDashboard";
import { PluginHost } from "./components/PluginHost";
import { MatchChat } from "./components/MatchChat";
import { loadSubplatform, resolveSubplatform, subplatformCopy, subplatformFieldLabel, type SubplatformConfig } from "./subplatform";
import {
  createMarketplaceIntroduction,
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [secureConnection, setSecureConnection] = useState(true);

  const closeListing = useCallback(() => setListing(null), []);
  const closeModeDialog = useCallback(() => setModeDialogOpen(false), []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const requestedPath = window.location.pathname;
    setSecureConnection(window.location.protocol === "https:");
    setSubplatform(resolveSubplatform(requestedPath));
    void loadSubplatform(requestedPath).then(setSubplatform);
    setRole(roleFromLocation());
    setListing(listingFromLocation());
    setHydrated(true);
  }, []);

  useEffect(() => {
    void authClient
      .getSession({ fetchOptions: authFetchOptions(subplatform.slug) })
      .then(({ data }) => {
        const user = data?.user as AuthenticatedUser | undefined;
        setAuthUser(user?.id ? user : null);
        const requestedRole = roleFromLocation();
        const userRole = user?.role;
        const isRootManager = userRole === "rootSuperAdmin" || userRole === "rootAdmin";
        if (requestedRole === "platform" && !isRootManager) {
          setRole("buyer");
          setNotice("平台管理仅对根平台管理员开放，请使用管理员入口登录");
        }
      })
      .catch(() => {
        setAuthUser(null);
        if (roleFromLocation() === "platform") {
          setRole("buyer");
          setNotice("请先使用根平台管理员账号登录");
        }
      });
  }, [subplatform.slug]);

  const openAccount = () => {
    if (authUser) {
      setAccountMenuOpen((open) => !open);
      return;
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("role", role);
    const next = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    window.location.assign(`/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`);
  };

  const signOut = async () => {
    try {
      const result = await authClient.signOut({ fetchOptions: authFetchOptions(subplatform.slug) });
      if (result.error) throw new Error(result.error.message || "退出登录失败");
      clearPartySessionCache();
      setAuthUser(null);
      setAccountMenuOpen(false);
      setNotice(ui.signedOut);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : ui.signOutFailed);
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    const url = new URL(window.location.href);
    url.searchParams.set("role", role);
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

  const genericWorkspace: ReactNode = role === "buyer" ? (
    <BuyerDashboard listings={listings} onOpenListing={setListing} onNotice={setNotice} subplatform={subplatform} />
  ) : role === "seller" ? (
    <SellerDashboard onNotice={setNotice} subplatform={subplatform} />
  ) : role === "subplatform_admin" ? (
    <SubplatformAdminDashboard onNotice={setNotice} subplatform={subplatform} />
  ) : (
    <PlatformDashboard
      paymentMode={paymentMode}
      onRequestModeChange={() => setModeDialogOpen(true)}
      onNotice={setNotice}
    />
  );

  return (
    <MotionConfig reducedMotion="user" transition={spring}>
      <div id="top" className="app-shell">
        <a className="skip-link" href="#main-content">{ui.skipToContent}</a>
        <header className="app-header">
          <div className="header-inner">
            <div className="brand-cluster">
              <Brand
                label={subplatform.brandName}
                homeHref={subplatform.slug === "root" ? "#top" : `/${subplatform.slug}`}
              />
              {subplatform.slug !== "root" ? <a className="root-platform-link" href="/">{ui.rootPlatform}</a> : null}
            </div>
            <div className="header-actions">
              <span className={`secure-status${secureConnection ? "" : " is-insecure"}`}><ShieldCheck size={15} aria-hidden="true" />{secureConnection ? ui.secure : ui.insecure}</span>
              <IconButton label={ui.notifications} onClick={() => setNotice(ui.noNotifications) }><Bell size={19} aria-hidden="true" /></IconButton>
              <button className="profile-button" type="button" aria-label={authUser ? ui.openAccount : ui.signIn} aria-expanded={authUser ? accountMenuOpen : undefined} onClick={openAccount}>
                <span><UserRound size={18} aria-hidden="true" /></span>
                <span className="profile-copy"><strong>{authUser?.name || subplatform.brandName}</strong><small>{authUser ? roleLabel(role, locale, subplatform) : ui.signIn}</small></span>
              </button>
              <AnimatePresence>
                {authUser && accountMenuOpen ? (
                  <motion.div
                    className="account-menu"
                    role="menu"
                    aria-label={ui.accountMenu}
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={spring}
                  >
                    <div className="account-menu-identity">
                      <strong>{authUser.name || ui.user}</strong>
                      <small>{authUser.email || ui.unifiedIdentity}</small>
                    </div>
                    <div className="account-menu-links">
                      <a role="menuitem" href={`${window.location.pathname}?role=buyer`}>{ui.buyerWorkspace}</a>
                      <a role="menuitem" href={`${window.location.pathname}?role=seller`}>{ui.sellerWorkspace}</a>
                      {authUser.role === "rootSuperAdmin" || authUser.role === "rootAdmin" ? (
                        <a role="menuitem" href="/?role=platform">{ui.platformAdmin}</a>
                      ) : null}
                    </div>
                    <div className="account-menu-preferences">
                      <PreferenceControls theme={theme} locale={locale} onThemeChange={setTheme} onLocaleChange={setLocale} />
                    </div>
                    <button className="account-menu-signout" type="button" role="menuitem" onClick={() => void signOut()}>{ui.signOut}</button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </header>

        <main id="main-content" tabIndex={-1}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={role}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={spring}
            >
              {role === "buyer" || role === "seller" ? (
                <MatchChat
                  role={role}
                  onNotice={setNotice}
                  onRecommendations={(recommendations) => setListings(mapRecommendations(recommendations, subplatform))}
                  subplatform={subplatform}
                />
              ) : null}
              {subplatform.pluginArtifact ? (
                <PluginHost role={role} onNotice={setNotice} subplatform={subplatform} fallback={genericWorkspace} />
              ) : genericWorkspace}
            </motion.div>
          </AnimatePresence>
        </main>

        <ListingSheet
          listing={listing}
          subplatform={subplatform}
          onClose={closeListing}
          onContact={async (selected) => {
            if (!isLiveMarketplaceEnabled()) {
              closeListing();
              setNotice(`${selected.title} ${subplatformCopy(subplatform, "contactRequestSubmittedSuffix", "的联系申请已提交")}`);
              return;
            }
            const isGenericOffer = Boolean(selected.offerId && selected.intentId);
            const listingId = isGenericOffer ? null : listingIdFromBackend(selected);
            if (!isGenericOffer && !listingId) {
              setNotice("供给必须来自当前子平台的真实 API；当前未发送申请");
              return;
            }
            if (!subplatform.domainId || (!isGenericOffer && !subplatform.currency)) {
              setNotice("当前子平台尚未完成身份与结算配置；当前未发送申请");
              return;
            }
            try {
              const session = await getMarketplaceSession({
                subplatform: subplatform.slug,
                platformPath: subplatform.path,
                tenantId: subplatform.tenantId,
                domainId: subplatform.domainId,
                role: "buyer",
              });
              if (!session) {
                setNotice("请先使用 Better Auth 邮箱登录，再申请联系");
                return;
              }
              if (isGenericOffer && selected.offerId && selected.intentId) {
                const introduction = await createMarketplaceIntroduction({
                  session,
                  domainId: subplatform.domainId,
                  intentId: selected.intentId,
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
                  domainId: subplatform.domainId,
                  introductionId,
                });
              } else if (listingId && subplatform.currency) {
                await createBuyerIntroduction({
                  session,
                  domainId: subplatform.domainId,
                  listingId,
                  narrative: subplatformCopy(subplatform, "contactIntentNarrative", "希望与供给方直接沟通并完成后续协商"),
                  requirements: {},
                  currency: subplatform.currency,
                  currencyScale: subplatform.currencyScale ?? 0,
                  exposureKey: `web-contact-${Date.now()}`,
                });
              }
              closeListing();
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
              <span><ShieldCheck size={17} aria-hidden="true" /></span>
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
  return requested === "seller" || requested === "platform" || requested === "subplatform_admin" ? requested : "buyer";
}

function roleLabel(role: WorkspaceRole, locale: "zh" | "en", subplatform: SubplatformConfig): string {
  if (locale === "en") {
    return role === "buyer"
      ? subplatformCopy(subplatform, "demandRoleLabelEn", "Demand")
      : role === "seller"
        ? subplatformCopy(subplatform, "supplyRoleLabelEn", "Supply")
        : role === "subplatform_admin"
          ? subplatformCopy(subplatform, "subplatformAdminLabelEn", "Platform admin")
          : subplatformCopy(subplatform, "platformAdminLabelEn", "Admin");
  }
  return role === "buyer"
    ? subplatformCopy(subplatform, "demandRoleLabel", "需求方")
    : role === "seller"
      ? subplatformCopy(subplatform, "supplyRoleLabel", "供给方")
      : role === "subplatform_admin"
        ? subplatformCopy(subplatform, "subplatformAdminLabel", "子平台管理员")
        : subplatformCopy(subplatform, "platformAdminLabel", "平台管理员");
}

function appCopy(locale: "zh" | "en") {
  if (locale === "en") {
    return {
      skipToContent: "Skip to content",
      rootPlatform: "Root platform",
      secure: "Secure",
      insecure: "Local connection",
      notifications: "Notifications",
      noNotifications: "No new notifications",
      openAccount: "Open account menu",
      signIn: "Sign in",
      accountMenu: "Account menu",
      user: "MatchPlane user",
      unifiedIdentity: "Unified identity",
      buyerWorkspace: "Buyer workspace",
      sellerWorkspace: "Seller workspace",
      platformAdmin: "Platform admin",
      signOut: "Sign out",
      signedOut: "Signed out",
      signOutFailed: "Could not sign out. Try again.",
    };
  }
  return {
    skipToContent: "跳到主要内容",
    rootPlatform: "根平台",
    secure: "安全连接",
    insecure: "本地连接",
    notifications: "通知",
    noNotifications: "目前没有新的平台通知",
    openAccount: "打开个人账户菜单",
    signIn: "登录",
    accountMenu: "个人账户菜单",
    user: "MatchPlane 用户",
    unifiedIdentity: "已登录的统一身份",
    buyerWorkspace: "买方工作台",
    sellerWorkspace: "卖方工作台",
    platformAdmin: "根平台管理",
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

function mapRecommendations(items: RecommendedBackendListing[], subplatform: SubplatformConfig): AssetListing[] {
  return items.flatMap((item, index) => {
    const id = item.listing_id ?? item.offer_id;
    if (!id) return [];
    const attributes = item.attributes && typeof item.attributes === "object" && !Array.isArray(item.attributes)
      ? item.attributes
      : {};
    const facts = Object.entries(attributes)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 4)
      .map(([label, value]) => ({ label: subplatformFieldLabel(subplatform, label), key: label, value: String(value) }));
    const subtitle = facts.slice(0, 2).map((fact) => `${fact.label} ${fact.value}`).join(" · ");
    const location = typeof item.location === "string" && item.location.trim() ? item.location.trim() : undefined;
    const terms = item.terms && typeof item.terms === "object" && !Array.isArray(item.terms) ? item.terms : {};
    const currencyScale = item.currency_scale;
    const price = item.asking_amount && item.currency && typeof currencyScale === "number" && Number.isInteger(currencyScale)
      ? formatMoney(item.asking_amount, item.currency, currencyScale)
      : stringAttribute(terms, ["display_price", "price_label", "price"]) ?? "—";
    return [{
      id,
      title: item.display_name,
      subtitle,
      price,
      location,
      matchScore: Math.round(Math.max(0, Math.min(1, item.match_score ?? 0)) * 100),
      accent: (["cactus", "clay", "heather", "oat"] as const)[index % 4],
      facts,
      reasons: item.match_reasons ?? (typeof item.reasons === "object" && Array.isArray(item.reasons) ? item.reasons.filter((reason): reason is string => typeof reason === "string") : undefined),
      trust: stringArrayAttribute(item, ["trust", "verification_labels", "verificationLabels"]),
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
