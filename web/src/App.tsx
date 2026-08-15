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
import { Brand, IconButton, spring } from "./components/Primitives";
import { SellerDashboard } from "./components/SellerDashboard";
import { SubplatformAdminDashboard } from "./components/SubplatformAdminDashboard";
import { PluginHost } from "./components/PluginHost";
import { MatchChat } from "./components/MatchChat";
import { loadSubplatform, resolveSubplatform, type SubplatformConfig } from "./subplatform";
import {
  createBuyerIntroduction,
  getPaymentSetting,
  type RecommendedBackendListing,
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  switchPaymentMode,
} from "./api";
import { getMarketplaceSession } from "./lib/marketplace-session";
import { authClient, authFetchOptions } from "./lib/auth-client";
import type { AssetListing, WorkspaceRole } from "./types";

export function App({ initialPath = "/" }: { initialPath?: string }) {
  const [role, setRole] = useState<WorkspaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() => resolveSubplatform(initialPath));
  const [listings, setListings] = useState<AssetListing[]>([]);
  const [listing, setListing] = useState<AssetListing | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"test" | "production">("test");
  const [paymentModeVersion, setPaymentModeVersion] = useState(1);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const closeListing = useCallback(() => setListing(null), []);
  const closeModeDialog = useCallback(() => setModeDialogOpen(false), []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const requestedPath = window.location.pathname;
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
        const requestedRole = roleFromLocation();
        const userRole = (data?.user as { role?: string } | undefined)?.role;
        const isRootManager = userRole === "rootSuperAdmin" || userRole === "rootAdmin";
        if (requestedRole === "platform" && !isRootManager) {
          setRole("buyer");
          setNotice("平台管理仅对根平台管理员开放，请使用管理员入口登录");
        }
      })
      .catch(() => {
        if (roleFromLocation() === "platform") {
          setRole("buyer");
          setNotice("请先使用根平台管理员账号登录");
        }
      });
  }, [subplatform.slug]);

  useEffect(() => {
    if (!hydrated) return;
    const url = new URL(window.location.href);
    url.searchParams.set("role", role);
    window.history.replaceState(null, "", url);
  }, [hydrated, role]);

  useEffect(() => {
    if (!hydrated || role !== "platform" || !isLiveMarketplaceEnabled()) return;
    if (!subplatform.tenantId) {
      setNotice("当前根平台尚未配置 tenant，暂时不能读取真实支付模式");
      return;
    }
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
      if (!subplatform.tenantId) {
        setModeDialogOpen(false);
        setNotice("当前根平台尚未配置 tenant，无法修改真实支付模式");
        return;
      }
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
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <header className="app-header">
          <div className="header-inner">
            <div className="brand-cluster">
              <Brand
                label={subplatform.brandName}
                homeHref={subplatform.slug === "root" ? "#top" : `/${subplatform.slug}`}
              />
              {subplatform.slug !== "root" ? <a className="root-platform-link" href="/">根平台</a> : null}
            </div>
            <div className="header-actions">
              <span className="secure-status"><ShieldCheck size={15} aria-hidden="true" />安全连接</span>
              <IconButton label="通知" onClick={() => setNotice("目前没有新的平台通知") }><Bell size={19} aria-hidden="true" /></IconButton>
              <button className="profile-button" type="button" aria-label="打开个人账户" onClick={() => window.location.assign(`/login?role=${role}&next=${encodeURIComponent(window.location.pathname)}`)}>
                <span><UserRound size={18} aria-hidden="true" /></span>
                <span className="profile-copy"><strong>{subplatform.brandName}</strong><small>{role === "buyer" ? "买家" : role === "seller" ? "卖家" : "管理员"}</small></span>
              </button>
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
              <MatchChat
                onNotice={setNotice}
                onRecommendations={(recommendations) => setListings(mapRecommendations(recommendations))}
                subplatform={subplatform}
              />
              {subplatform.pluginArtifact ? (
                <PluginHost role={role} onNotice={setNotice} subplatform={subplatform} fallback={genericWorkspace} />
              ) : genericWorkspace}
            </motion.div>
          </AnimatePresence>
        </main>

        <ListingSheet
          listing={listing}
          onClose={closeListing}
          onContact={async (selected) => {
            if (!isLiveMarketplaceEnabled()) {
              closeListing();
              setNotice(`${selected.title} 的联系与看车申请已提交`);
              return;
            }
            const listingId = listingIdFromBackend(selected);
            if (!listingId) {
              setNotice("供给必须来自当前子平台的真实 API；当前未发送申请");
              return;
            }
            if (!subplatform.domainId || !subplatform.currency) {
              setNotice("当前子平台尚未完成 domain 与结算币种注册；当前未发送申请");
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
              await createBuyerIntroduction({
                session,
                domainId:
                  subplatform.domainId,
                listingId,
                narrative: "希望与供给方直接沟通并完成后续协商",
                requirements: {},
                currency: subplatform.currency,
                currencyScale: subplatform.currencyScale ?? 0,
                exposureKey: `web-contact-${Date.now()}`,
              });
              closeListing();
              setNotice("联系申请已真实写入撮合系统，等待卖家明确同意后交换电话/微信");
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

function listingFromLocation(): AssetListing | null {
  // Listings are loaded from the root API/subplatform adapter. Never hydrate a fabricated
  // inventory item from a URL parameter.
  return null;
}

function mapRecommendations(items: RecommendedBackendListing[]): AssetListing[] {
  return items.map((item, index) => {
    const attributes = item.attributes && typeof item.attributes === "object" && !Array.isArray(item.attributes)
      ? item.attributes
      : {};
    const facts = Object.entries(attributes)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 4)
      .map(([label, value]) => ({ label, value: String(value) }));
    const subtitle = facts.slice(0, 2).map((fact) => `${fact.label} ${fact.value}`).join(" · ") || "来自当前子平台的真实供给";
    const location = attributeText(attributes, ["location", "city", "地区", "城市"]);
    return {
      id: item.listing_id,
      title: item.display_name,
      subtitle,
      price: formatMoney(item.asking_amount, item.currency, item.currency_scale),
      location,
      matchScore: Math.round(Math.max(0, Math.min(1, item.match_score)) * 100),
      accent: (["cactus", "clay", "heather", "oat"] as const)[index % 4],
      facts,
      reasons: item.match_reasons,
      trust: ["审核通过", "匹配理由可解释"],
      response: "由当前子平台供给方确认",
    };
  });
}

function attributeText(attributes: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return value.trim();
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
