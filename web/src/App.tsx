"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  LogIn,
  LogOut,
  ShieldCheck,
  Store,
  UserRound,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { ListingSheet, ModeDialog } from "./components/Overlays";
import { PlatformDashboard } from "./components/PlatformDashboard";
import { PreferenceControls } from "./components/PreferenceControls";
import { Brand, spring } from "./components/Primitives";
import { SubplatformAdminDashboard } from "./components/SubplatformAdminDashboard";
import { PluginHost } from "./components/PluginHost";
import { MarketplaceHome } from "./components/MarketplaceHome";
import { IdentityBindingsPanel } from "./components/IdentityBindingsPanel";
import { PasskeyPanel } from "./components/PasskeyPanel";
import { SessionPanel } from "./components/SessionPanel";
import { PersonalProfilePanel } from "./components/PersonalProfilePanel";
import { NotificationBell } from "./components/NotificationBell";
import { PlatformFooter } from "./components/PlatformFooter";
import { PlatformMenu } from "./components/PlatformMenu";
import { StorefrontView } from "./components/StorefrontView";
import { HostedStoreOnboarding } from "./components/HostedStoreOnboarding";
import { WorkspaceSettingsDialog } from "./components/WorkspaceSettingsDialog";
import { ChangePasswordPanel } from "./components/ChangePasswordPanel";
import {
  loadSubplatform,
  resolveSubplatform,
  subplatformCopy,
  type SubplatformConfig,
} from "./subplatform";
import {
  createMarketplaceIntroduction,
  createMarketplaceIntent,
  createMarketplaceSalesHandoff,
  browseMallCatalog,
  getMarketplaceOfferLikes,
  getMarketplaceProfile,
  getOwnedStores,
  requestMarketplaceContact,
  createBuyerIntroduction,
  clearPartySessionCache,
  getPaymentSetting,
  type MallAssistantContactConsentAction,
  type StoreSummary,
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  MarketplaceApiError,
  notifyStoreCustomerHandoff,
  setMarketplaceOfferLikeCount,
  switchPaymentMode,
} from "./api";
import { getMarketplaceSession } from "./lib/marketplace-session";
import { authClient, authFetchOptions } from "./lib/auth-client";
import { useInterfacePreferences } from "./lib/preferences";
import { mapRecommendations } from "./marketplace-listings";
import type { AssetListing, WorkspaceRole } from "./types";

const AUTH_PENDING_KEY = "matchplane.auth.pending";

interface AuthenticatedUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
}

type AccountSettingsSection = "profile" | "account" | "stores";

interface StoreConsoleContext {
  subplatform: SubplatformConfig;
  store: StoreSummary;
}

export function App({ initialPath = "/" }: { initialPath?: string }) {
  const { theme, locale, setTheme, setLocale } = useInterfacePreferences();
  const ui = appCopy(locale);
  const [role, setRole] = useState<WorkspaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() =>
    resolveSubplatform(initialPath),
  );
  const [listings, setListings] = useState<AssetListing[]>([]);
  const [catalogResolved, setCatalogResolved] = useState(false);
  const [listing, setListing] = useState<AssetListing | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"test" | "production">("test");
  const [paymentModeVersion, setPaymentModeVersion] = useState(1);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [accountSettingsSection, setAccountSettingsSection] =
    useState<AccountSettingsSection | null>(null);
  const [storeConsoleOpen, setStoreConsoleOpen] = useState(false);
  const [storeConsoleContext, setStoreConsoleContext] =
    useState<StoreConsoleContext | null>(null);
  const [storeConsoleRequested, setStoreConsoleRequested] = useState(false);
  const [publishProductRequested, setPublishProductRequested] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [pluginFailed, setPluginFailed] = useState(false);
  const [ownedStores, setOwnedStores] = useState<StoreSummary[]>([]);
  const [ownedStoresResolved, setOwnedStoresResolved] = useState(false);
  // Keep the requested destination independent from the URL that hydration normalizes to the
  // safe buyer surface. Otherwise `?role=platform` can be overwritten before Better Auth
  // resolves, which silently strands a valid administrator in the buyer workspace.
  const requestedRoleRef = useRef<WorkspaceRole>(roleFromLocation());
  const catalogInteractionRef = useRef(false);
  const catalogPathRef = useRef(subplatform.path);

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
    const searchParams = new URLSearchParams(window.location.search);
    const accountTarget = searchParams.get("account");
    let cleanWorkspaceTarget = false;
    if (accountTarget === "identity") {
      setAccountSettingsSection("account");
      searchParams.delete("account");
      cleanWorkspaceTarget = true;
    }
    if (accountTarget === "profile") {
      setAccountSettingsSection("profile");
      searchParams.delete("account");
      cleanWorkspaceTarget = true;
    }
    if (searchParams.get("stores") === "1") {
      setAccountSettingsSection("stores");
      searchParams.delete("stores");
      cleanWorkspaceTarget = true;
    }
    if (searchParams.get("console") === "products") {
      setStoreConsoleRequested(true);
      searchParams.delete("console");
      cleanWorkspaceTarget = true;
    }
    if (searchParams.get("publish") === "1") setPublishProductRequested(true);
    if (cleanWorkspaceTarget)
      window.history.replaceState(
        null,
        "",
        relativeBrowserLocation(searchParams),
      );
    setSubplatform(resolveSubplatform(requestedPath));
    void loadSubplatform(requestedPath).then(setSubplatform);
    const requestedRole = roleFromLocation();
    requestedRoleRef.current = requestedRole;
    // Never render a privileged or supply workspace while the Better Auth
    // session check is still pending. The authenticated effect below restores
    // the requested role only after a real session is available.
    setRole(
      requiresAuthenticatedWorkspace(requestedRole) ? "buyer" : requestedRole,
    );
    setListing(listingFromLocation());
    setHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A transient session-check failure (rate limiting, gateway restart, or a
    // short network interruption) is not evidence that the user signed out.
    // Retry it without redirecting; only a successful anonymous response may
    // send an authenticated workspace to the login screen.
    setAuthResolved(false);
    const resolveSession = async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let result: Awaited<ReturnType<typeof authClient.getSession>>;
        try {
          result = await authClient.getSession({
            fetchOptions: authFetchOptions(subplatform.slug),
          });
        } catch (error) {
          if (cancelled) return;
          if (attempt < 4) {
            await waitForAuthRetry(attempt);
            continue;
          }
          setAuthResolved(true);
          setNotice(authSessionFailureMessage(error));
          return;
        }
        if (cancelled) return;
        if (result.error) {
          if (attempt < 4 && isTransientAuthError(result.error)) {
            await waitForAuthRetry(attempt);
            continue;
          }
          setAuthResolved(true);
          setNotice(authSessionFailureMessage(result.error));
          return;
        }

        const user = result.data?.user as AuthenticatedUser | undefined;
        if (!user?.id && hasRecentPendingAuthentication() && attempt < 4) {
          await waitForAuthRetry(attempt);
          continue;
        }
        window.sessionStorage.removeItem(AUTH_PENDING_KEY);
        setAuthUser(user?.id ? user : null);
        setAuthResolved(true);
        const requestedRole = requestedRoleRef.current;
        const userRole = user?.role;
        const isRootManager =
          userRole === "rootSuperAdmin" || userRole === "rootAdmin";
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
        return;
      }
    };
    void resolveSession();
    return () => {
      cancelled = true;
    };
  }, [subplatform.slug]);

  useEffect(() => {
    let cancelled = false;
    if (!authUser?.id) {
      setOwnedStores([]);
      setOwnedStoresResolved(false);
      return () => {
        cancelled = true;
      };
    }
    setOwnedStoresResolved(false);
    void getOwnedStoresWithRetry()
      .then((stores) => {
        if (!cancelled) setOwnedStores(stores);
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice(
            error instanceof Error
              ? error.message
              : "我的店铺暂时无法读取，请稍后重试",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setOwnedStoresResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!hydrated) {
      return () => {
        cancelled = true;
      };
    }
    if (catalogPathRef.current !== subplatform.path) {
      catalogPathRef.current = subplatform.path;
      catalogInteractionRef.current = false;
    }
    setCatalogResolved(false);
    void browseMallCatalog(
      subplatform.slug === "root" ? {} : { storePath: subplatform.path },
    )
      .then(({ recommendations }) => {
        if (!cancelled && !catalogInteractionRef.current) {
          setListings(mapRecommendations(recommendations, subplatform, locale));
        }
      })
      .catch(() => {
        // The live store directory remains available when the product feed is temporarily down.
      })
      .finally(() => {
        if (!cancelled) setCatalogResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, locale, subplatform.path, subplatform.slug]);

  const listingOfferIds = listings
    .flatMap((item) => item.offerId ?? listingIdFromBackend(item) ?? [])
    .filter((offerId, position, all) => all.indexOf(offerId) === position)
    .sort((left, right) => left.localeCompare(right))
    .join(",");

  useEffect(() => {
    let cancelled = false;
    if (!authUser?.id || !listingOfferIds) {
      if (!authUser?.id) {
        setListings((current) =>
          current.map((item) =>
            item.viewerLikeCount ? { ...item, viewerLikeCount: 0 } : item,
          ),
        );
      }
      return () => {
        cancelled = true;
      };
    }
    void getMarketplaceOfferLikes(listingOfferIds.split(","))
      .then((states) => {
        if (cancelled) return;
        const byOfferId = new Map(
          states.map((state) => [state.offerId, state]),
        );
        setListings((current) =>
          current.map((item) => {
            const offerId = item.offerId ?? listingIdFromBackend(item);
            const state = offerId ? byOfferId.get(offerId) : undefined;
            return state
              ? {
                  ...item,
                  likeTotal: state.likeTotal,
                  viewerLikeCount: state.viewerLikeCount,
                }
              : item;
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authUser?.id, listingOfferIds]);

  const currentManagedStore =
    subplatform.slug === "root"
      ? null
      : (ownedStores.find((store) => store.path === subplatform.path) ?? null);
  const selectedManagedStore = listing
    ? (ownedStores.find(
        (store) =>
          (listing.storeId && store.id === listing.storeId) ||
          store.path === listing.platformPath,
      ) ?? null)
    : null;
  const canManageStoreConsole = canManageStore(
    authUser,
    storeConsoleContext?.store ?? null,
  );

  const openStoreConsoleFor = useCallback(
    async (store: StoreSummary) => {
      try {
        const storeSubplatform = await loadSubplatform(store.path);
        setStoreConsoleContext({ subplatform: storeSubplatform, store });
        setStoreConsoleOpen(true);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : locale === "en"
              ? "The store workspace is temporarily unavailable."
              : "店铺工作台暂时不可用",
        );
        setAccountSettingsSection("stores");
      }
    },
    [locale],
  );

  useEffect(() => {
    if (!storeConsoleRequested || !ownedStoresResolved) return;
    setStoreConsoleRequested(false);
    if (!authUser) {
      window.location.assign(loginHref("buyer"));
      return;
    }
    if (!currentManagedStore) {
      setNotice("只有店主或店铺运营人员可以管理这家店");
      return;
    }
    setStoreConsoleContext({ subplatform, store: currentManagedStore });
    setStoreConsoleOpen(true);
  }, [
    authUser,
    currentManagedStore,
    ownedStoresResolved,
    storeConsoleRequested,
    subplatform,
  ]);

  useEffect(() => {
    if (!authResolved || !authUser || typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get(
      "accountSection",
    );
    if (requested === "account" || requested === "profile" || requested === "stores")
      setAccountSettingsSection(requested);
  }, [authResolved, authUser]);

  useEffect(() => {
    if (!publishProductRequested || !authResolved) return;
    if (!authUser) {
      window.location.assign(
        `/login?next=${encodeURIComponent("/?publish=1")}`,
      );
      return;
    }
    if (!ownedStoresResolved) return;

    setPublishProductRequested(false);
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.delete("publish");
    window.history.replaceState(
      null,
      "",
      relativeBrowserLocation(searchParams),
    );
    if (ownedStores.length === 1) {
      void openStoreConsoleFor(ownedStores[0]);
      return;
    }
    setAccountSettingsSection("stores");
  }, [
    authResolved,
    authUser,
    ownedStores,
    ownedStoresResolved,
    publishProductRequested,
    openStoreConsoleFor,
  ]);

  const publishProduct = () => {
    if (!authResolved || (authUser && !ownedStoresResolved)) {
      setPublishProductRequested(true);
      setNotice(locale === "en" ? "Loading your stores…" : "正在读取你的店铺…");
      return;
    }
    if (!authUser) {
      window.location.assign(
        `/login?next=${encodeURIComponent("/?publish=1")}`,
      );
      return;
    }
    if (ownedStores.length === 1) {
      void openStoreConsoleFor(ownedStores[0]);
      return;
    }
    setAccountSettingsSection("stores");
  };

  const openSignIn = () => {
    window.location.assign(loginHref(role));
  };

  const likeListing = async (target: AssetListing) => {
    if (!authUser) {
      openSignIn();
      return;
    }
    const offerId = target.offerId ?? listingIdFromBackend(target);
    if (!offerId) {
      setNotice("这个商品暂不支持点赞");
      return;
    }
    const expectedCount = target.viewerLikeCount ?? 0;
    if (expectedCount >= 5) return;
    try {
      const state = await setMarketplaceOfferLikeCount({
        offerId,
        count: expectedCount + 1,
        expectedCount,
      });
      const applyState = (item: AssetListing) =>
        (item.offerId ?? listingIdFromBackend(item)) === offerId
          ? {
              ...item,
              likeTotal: state.likeTotal,
              viewerLikeCount: state.viewerLikeCount,
            }
          : item;
      setListings((current) => current.map(applyState));
      setListing((current) => (current ? applyState(current) : current));
    } catch (error) {
      if (error instanceof MarketplaceApiError && error.status === 401) {
        openSignIn();
        return;
      }
      if (error instanceof MarketplaceApiError && error.status === 409) {
        const [state] = await getMarketplaceOfferLikes([offerId]).catch(
          () => [],
        );
        if (state) {
          setListings((current) =>
            current.map((item) =>
              (item.offerId ?? listingIdFromBackend(item)) === offerId
                ? {
                    ...item,
                    likeTotal: state.likeTotal,
                    viewerLikeCount: state.viewerLikeCount,
                  }
                : item,
            ),
          );
          return;
        }
      }
      setNotice(error instanceof Error ? error.message : "点赞失败");
    }
  };

  const requestStoreContactConsent = async (
    action: MallAssistantContactConsentAction,
  ) => {
    if (!isLiveMarketplaceEnabled())
      throw new Error("当前环境未连接真实撮合 API");
    if (!subplatform.domainId || subplatform.slug === "root")
      throw new Error("当前店铺尚未完成联系交换配置");
    const selected = listings.find(
      (item) =>
        item.offerId === action.productId || item.id === action.productId,
    );
    if (!selected?.offerId)
      throw new Error("同意卡关联的商品已经下架，请继续咨询 AI 店长");
    const session = await getMarketplaceSession({
      subplatform: subplatform.slug,
      platformPath: subplatform.path,
      tenantId: subplatform.tenantId,
      domainId: subplatform.domainId,
      role: "buyer",
    });
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      throw new Error("请先登录再确认联系方式交换");
    }
    const intent = await createMarketplaceIntent({
      session,
      domainId: subplatform.domainId,
      side: "demand",
      narrative: `我同意使用账号中已验证的联系方式，进一步了解并购买“${selected.title}”`,
      attributes: {
        source: "store_ai_contact_consent",
        offer_id: selected.offerId,
        platform_path: subplatform.path,
      },
      supplyDiscoveryEnabled: false,
      idempotencyKey: `store-ai-contact-${selected.offerId}`,
    });
    const profile = await getMarketplaceProfile({
      session,
      domainId: subplatform.domainId,
    }).catch(() => null);
    const handoff = await createMarketplaceSalesHandoff({
      session,
      domainId: subplatform.domainId,
      intentId: intent.intent_id,
      summary: {
        source: "store_ai_contact_consent",
        offer_id: selected.offerId,
        offer_title: selected.title,
        platform_path: subplatform.path,
        analysis: action.reason,
        intent_strength: "high",
        product_ids: [selected.offerId],
        profile: profile?.profile ?? null,
        ai_continues: true,
        contact_consent: "accepted",
      },
      idempotencyKey: `store-ai-consent-handoff-${intent.intent_id}-${selected.offerId}`,
    });
    const introduction = await createMarketplaceIntroduction({
      session,
      domainId: subplatform.domainId,
      intentId: intent.intent_id,
      offerId: selected.offerId,
      score: (selected.matchScore ?? 0) / 100,
      idempotencyKey: `store-ai-consent-${Date.now()}`,
    });
    const introductionId =
      typeof introduction.introduction_id === "string"
        ? introduction.introduction_id
        : null;
    if (!introductionId)
      throw new Error("撮合结果缺少介绍编号，未发送联系申请");
    await requestMarketplaceContact({
      session,
      domainId: subplatform.domainId,
      introductionId,
    });
    const handoffId =
      typeof handoff.handoff_id === "string" ? handoff.handoff_id : null;
    if (handoffId)
      await notifyStoreCustomerHandoff(subplatform.path, handoffId);
    window.dispatchEvent(new Event("matchplane.contact.updated"));
    setNotice("联系申请已发送；只有店员也同意后才会交换已验证绑定");
  };

  const requestStoreAiHandoff = async (input: {
    requestId: string;
    summary: string;
    intent: "warm" | "high" | "urgent";
    productIds: string[];
  }) => {
    if (!subplatform.domainId || subplatform.slug === "root")
      throw new Error("当前店铺尚未接入客户跟进能力");
    const session = await getMarketplaceSession({
      subplatform: subplatform.slug,
      platformPath: subplatform.path,
      tenantId: subplatform.tenantId,
      domainId: subplatform.domainId,
      role: "buyer",
    });
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      throw new Error("请先登录再请求人工介入");
    }
    const signalKey = stableIdempotencyPart(
      [
        subplatform.path,
        input.intent,
        input.summary,
        ...[...input.productIds].sort(),
      ].join("\n"),
    );
    const intent = await createMarketplaceIntent({
      session,
      domainId: subplatform.domainId,
      side: "demand",
      narrative: input.summary,
      attributes: {
        source: "store_ai_manager",
        platform_path: subplatform.path,
        product_ids: input.productIds,
        intent_strength: input.intent,
      },
      supplyDiscoveryEnabled: false,
      idempotencyKey: `store-ai-intent-${signalKey}`,
    });
    const handoff = await createMarketplaceSalesHandoff({
      session,
      domainId: subplatform.domainId,
      intentId: intent.intent_id,
      summary: {
        source: "store_ai_manager",
        platform_path: subplatform.path,
        analysis: input.summary,
        intent_strength: input.intent,
        product_ids: input.productIds,
        ai_continues: true,
        contact_consent: "not_requested",
      },
      idempotencyKey: `store-ai-handoff-${signalKey}`,
    });
    const handoffId =
      typeof handoff.handoff_id === "string" ? handoff.handoff_id : null;
    if (!handoffId) throw new Error("人工介入记录缺少编号");
    await notifyStoreCustomerHandoff(subplatform.path, handoffId);
    window.dispatchEvent(new Event("matchplane.contact.updated"));
    setNotice(
      locale === "en"
        ? "Store staff were notified. The AI manager remains available."
        : "已通知店员，AI 店长会继续和你对话。",
    );
  };

  const openStoreCenter = () => {
    setAccountMenuOpen(false);
    if (!authUser) {
      window.location.assign("/login?next=" + encodeURIComponent("/?stores=1"));
      return;
    }
    setAccountSettingsSection("stores");
  };

  const signOut = async () => {
    try {
      const result = await authClient.signOut({
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (result.error) throw new Error(result.error.message || "退出登录失败");
      clearPartySessionCache();
      setAuthUser(null);
      setAccountSettingsSection(null);
      setStoreConsoleOpen(false);
      setAccountMenuOpen(false);
      setRole("buyer");
      requestedRoleRef.current = "buyer";
      const searchParams = new URLSearchParams(window.location.search);
      searchParams.delete("role");
      window.history.replaceState(
        null,
        "",
        relativeBrowserLocation(searchParams),
      );
      setNotice(ui.signedOut);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : ui.signOutFailed);
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    const searchParams = new URLSearchParams(window.location.search);
    if (role === "buyer") searchParams.delete("role");
    else searchParams.set("role", role);
    window.history.replaceState(
      null,
      "",
      relativeBrowserLocation(searchParams),
    );
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
  };

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
        className={`app-shell${fullscreenPlugin ? " is-subplatform-fullscreen" : ""}`}
      >
        <a className="skip-link" href="#main-content">
          {ui.skipToContent}
        </a>
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
            <div className="subplatform-fullscreen-actions">
              {currentManagedStore ? (
                <button
                  className="subplatform-manage-link"
                  type="button"
                  onClick={() => {
                    setStoreConsoleContext({
                      subplatform,
                      store: currentManagedStore,
                    });
                    setStoreConsoleOpen(true);
                  }}
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
        ) : (
          <header className="app-header">
            <div className="header-inner">
              <div className="brand-cluster">
                <Brand
                  label={subplatform.brandName}
                  logoUrl={
                    subplatform.slug === "root"
                      ? subplatform.brandLogoUrl
                      : undefined
                  }
                  homeHref={
                    subplatform.slug === "root" ? "#top" : subplatform.path
                  }
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
                  onThemeChange={setTheme}
                  onLocaleChange={setLocale}
                />
                <motion.button
                  className="header-store-action"
                  type="button"
                  onClick={openStoreCenter}
                  whileTap={{ scale: 0.97 }}
                  transition={spring}
                >
                  <Store size={17} aria-hidden="true" />
                  <span>{authUser ? ui.myStores : ui.openStore}</span>
                  {authUser && ownedStoresResolved ? (
                    <strong
                      className="header-store-count"
                      aria-label={`${ui.myStores}: ${ownedStores.length}`}
                    >
                      {ownedStores.length}
                    </strong>
                  ) : null}
                </motion.button>
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
                {authUser?.role === "rootSuperAdmin" ||
                authUser?.role === "rootAdmin" ? (
                  <a className="header-admin-action" href="/?role=platform">
                    <UserRound size={17} aria-hidden="true" />
                    <span>{ui.platformAdmin}</span>
                  </a>
                ) : null}
                {authUser ? (
                  <NotificationBell locale={locale} userId={authUser.id} />
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
                    {accountMenuOpen ? (
                      <div
                        className="account-menu"
                        role="menu"
                        aria-label={ui.accountMenu}
                      >
                        <div className="account-menu-identity">
                          <strong>{authUser.name || ui.user}</strong>
                          <small>{authUser.email || ui.unifiedIdentity}</small>
                        </div>
                        <div className="account-menu-links">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAccountMenuOpen(false);
                              setAccountSettingsSection("profile");
                            }}
                          >
                            <UserRound size={16} aria-hidden="true" />
                            {ui.profile}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAccountMenuOpen(false);
                              setAccountSettingsSection("account");
                            }}
                          >
                            <UserRound size={16} aria-hidden="true" />
                            {ui.account}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            aria-label={ui.myStores}
                            onClick={() => {
                              setAccountMenuOpen(false);
                              setAccountSettingsSection("stores");
                            }}
                          >
                            <Store size={16} aria-hidden="true" />
                            <span>{ui.myStores}</span>
                            {ownedStoresResolved ? (
                              <strong className="account-menu-count">
                                {ownedStores.length}
                              </strong>
                            ) : null}
                          </button>
                        </div>
                        <button
                          className="account-menu-signout"
                          type="button"
                          role="menuitem"
                          onClick={() => void signOut()}
                        >
                          <LogOut size={16} aria-hidden="true" />
                          {ui.signOut}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </header>
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
                    listings={listings}
                    locale={locale}
                    onNotice={setNotice}
                    onOpenListing={setListing}
                    onLikeListing={likeListing}
                    onPublishProduct={publishProduct}
                    onRecommendations={(recommendations) => {
                      catalogInteractionRef.current = true;
                      setListings(
                        mapRecommendations(
                          recommendations,
                          subplatform,
                          locale,
                        ),
                      );
                    }}
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
                      onClick={() => void signOut()}
                    >
                      <LogOut size={16} aria-hidden="true" />
                      {ui.signOut}
                    </button>
                  </div>
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
                  window.location.assign(
                    `${selectedManagedStore.path}?console=products`,
                  );
                }
              : undefined
          }
          onContact={async (selected) => {
            const selectedPath = selected.platformPath || subplatform.path;
            const selectedSubplatform =
              selectedPath !== subplatform.path && selected.subplatform
                ? {
                    ...(await loadSubplatform(selectedPath)),
                    path: selectedPath,
                    slug: selected.subplatform,
                    ...(selected.tenantId
                      ? { tenantId: selected.tenantId }
                      : {}),
                    ...(selected.domainId
                      ? { domainId: selected.domainId }
                      : {}),
                  }
                : subplatform;
            const selectedTenantId =
              selected.tenantId || selectedSubplatform.tenantId;
            const selectedDomainId =
              selected.domainId || selectedSubplatform.domainId;
            if (!isLiveMarketplaceEnabled()) {
              setNotice("当前环境未连接真实撮合 API，未发送联系申请");
              return;
            }
            const isGenericOffer = Boolean(selected.offerId);
            const listingId = isGenericOffer
              ? null
              : listingIdFromBackend(selected);
            if (!isGenericOffer && !listingId) {
              setNotice("商品必须来自已接入店铺的真实目录；当前未发送申请");
              return;
            }
            if (
              !selectedDomainId ||
              (!isGenericOffer && !selectedSubplatform.currency)
            ) {
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
                window.location.assign(
                  `/login?next=${encodeURIComponent(next)}`,
                );
                return;
              }
              if (isGenericOffer && selected.offerId) {
                const selectedIntentId =
                  selected.intentId ??
                  (
                    await createMarketplaceIntent({
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
                    })
                  ).intent_id;
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
                      match_level:
                        selected.matchScore === undefined
                          ? null
                          : selected.matchScore >= 80
                            ? "very_suitable"
                            : selected.matchScore >= 60
                              ? "suitable"
                              : selected.matchScore >= 40
                                ? "possible"
                                : "weak",
                      reasons: selected.reasons ?? [],
                      risks: selected.risks ?? [],
                      recent_offer_ids: listings
                        .filter((item) => item.platformPath === selectedPath)
                        .map((item) => item.offerId ?? item.id)
                        .slice(0, 32),
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
                const introductionId =
                  typeof introduction.introduction_id === "string"
                    ? introduction.introduction_id
                    : null;
                if (!introductionId)
                  throw new Error("撮合结果缺少介绍编号，未发送联系申请");
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
                  narrative: subplatformCopy(
                    selectedSubplatform,
                    "contactIntentNarrative",
                    "希望与供给方直接沟通并完成后续协商",
                  ),
                  requirements: {},
                  currency: selectedSubplatform.currency,
                  currencyScale: selectedSubplatform.currencyScale ?? 0,
                  exposureKey: `web-contact-${Date.now()}`,
                });
              }
              window.dispatchEvent(new Event("matchplane.contact.updated"));
              setNotice(
                "联系申请已写入撮合系统，等待供给方明确同意后交换联系方式",
              );
            } catch (error) {
              setNotice(
                error instanceof Error
                  ? error.message
                  : "联系申请未发送，请稍后重试",
              );
            }
          }}
        />
        <ModeDialog
          open={modeDialogOpen}
          currentMode={paymentMode}
          onClose={closeModeDialog}
          onConfirm={confirmModeChange}
        />

        {notice ? (
          <p className="visually-hidden" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </MotionConfig>
  );
}

function isTransientAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status =
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
  return status === null || status === 408 || status === 429 || status >= 500;
}

function authSessionFailureMessage(error: unknown): string {
  const status =
    error && typeof error === "object"
      ? ((error as { status?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode)
      : null;
  return status === 429
    ? "登录状态检查过于频繁，请稍后刷新；当前会话不会被清除"
    : "暂时无法确认登录状态，请刷新后重试；当前会话不会被清除";
}

function hasRecentPendingAuthentication(): boolean {
  const startedAt = Number.parseInt(
    window.sessionStorage.getItem(AUTH_PENDING_KEY) ?? "",
    10,
  );
  return Number.isFinite(startedAt) && Date.now() - startedAt < 15_000;
}

async function getOwnedStoresWithRetry(): Promise<StoreSummary[]> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await getOwnedStores();
    } catch (error) {
      if (attempt >= 3 || !isTransientAuthError(error)) throw error;
      await waitForAuthRetry(attempt);
    }
  }
  return [];
}

function waitForAuthRetry(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    window.setTimeout(resolve, (attempt + 1) * 300),
  );
}

function stableIdempotencyPart(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function requestedStoreConsoleSection(): "products" | "customers" {
  if (typeof window === "undefined") return "products";
  return new URLSearchParams(window.location.search).get(
    "storeConsoleSection",
  ) === "customers"
    ? "customers"
    : "products";
}

function roleFromLocation(): WorkspaceRole {
  if (typeof window === "undefined") return "buyer";
  const requested = new URLSearchParams(window.location.search).get("role");
  return requested === "platform" ? requested : "buyer";
}

/** Administration is authenticated; the public matching conversation remains available to visitors. */
function requiresAuthenticatedWorkspace(role: WorkspaceRole): boolean {
  return role === "platform";
}

/** Keep the intended workspace through Better Auth without trusting an external redirect. */
function canManageStore(
  user: AuthenticatedUser | null,
  store: StoreSummary | null,
): boolean {
  return Boolean(
    user &&
      store &&
      (user.role === "rootSuperAdmin" ||
        user.role === "rootAdmin" ||
        store.membershipRole === "owner" ||
        store.membershipRole === "mall_operator"),
  );
}

function relativeBrowserLocation(searchParams: URLSearchParams): string {
  const query = searchParams.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

function loginHref(role: WorkspaceRole): string {
  if (typeof window === "undefined")
    return `/login?role=${encodeURIComponent(role)}`;
  const searchParams = new URLSearchParams(window.location.search);
  searchParams.set("role", role);
  const next = relativeBrowserLocation(searchParams);
  return `/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`;
}

function parentPlatformHref(path: string, role: WorkspaceRole): string {
  void path;
  return role === "buyer" ? "/" : `/?role=${encodeURIComponent(role)}`;
}

function roleLabel(
  role: WorkspaceRole,
  locale: "zh" | "en",
  subplatform: SubplatformConfig,
): string {
  void subplatform;
  if (locale === "en") {
    return role === "buyer" ? "Account" : "Mall operator";
  }
  return role === "buyer" ? "统一账号" : "商城运营";
}

function appCopy(locale: "zh" | "en") {
  if (locale === "en") {
    return {
      skipToContent: "Skip to content",
      backToParent: "Back to mall",
      rootPlatform: "Mall",
      myStores: "My stores",
      openStore: "Open a store",
      storeCenter: "My stores",
      myStoresDescription:
        "See every store you own or help run, then browse it or manage its products.",
      closeMyStores: "Close my stores",
      closeMyStoresDialog: "Close my stores dialog",
      manageStore: "Manage this store",
      closeStoreConsole: "Close store management",
      closeStoreConsoleDialog: "Close store management dialog",
      account: "Account",
      accountMenu: "Account menu",
      accountDescription:
        "Manage your password, passkeys, identity bindings, and signed-in devices.",
      profile: "Profile",
      profileDescription: "Choose your avatar and introduce yourself.",
      contact: "Contact details",
      contactDescription:
        "Set the buyer contact channels that can be shared only after mutual consent.",
      closeContact: "Close contact details",
      closeContactDialog: "Close contact details dialog",
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
    myStores: "我的店铺",
    openStore: "开一家店",
    storeCenter: "我的店铺",
    myStoresDescription:
      "查看你拥有或参与运营的全部店铺，再进入浏览或直接管理商品。",
    closeMyStores: "关闭我的店铺",
    closeMyStoresDialog: "关闭我的店铺对话框",
    manageStore: "管理这家店",
    closeStoreConsole: "关闭店铺管理",
    closeStoreConsoleDialog: "关闭店铺管理对话框",
    account: "账号",
    accountMenu: "账号菜单",
    accountDescription: "管理密码、通行密钥、身份绑定和登录设备。",
    profile: "个人资料",
    profileDescription: "设置头像和个人简介。",
    contact: "联系方式",
    contactDescription: "设置买家自己的联系方式；只有双方同意后才会交换。",
    closeContact: "关闭联系方式",
    closeContactDialog: "关闭联系方式对话框",
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
    const value = JSON.parse(
      window.localStorage.getItem(`matchplane.saved.${platformPath}`) ?? "[]",
    ) as unknown;
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .slice(0, 32)
      : [];
  } catch {
    return [];
  }
}
