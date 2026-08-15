"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Bell,
  LayoutDashboard,
  Menu,
  ShieldCheck,
  Sparkles,
  Store,
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
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  switchPaymentMode,
} from "./api";
import { getMarketplaceSession } from "./lib/marketplace-session";
import type { AssetListing, WorkspaceRole } from "./types";

const roles: Array<{ id: WorkspaceRole; label: string; shortLabel: string; icon: typeof Sparkles }> = [
  { id: "buyer", label: "买方需求", shortLabel: "需求", icon: Sparkles },
  { id: "seller", label: "卖方供给", shortLabel: "供给", icon: Store },
  { id: "platform", label: "平台管理", shortLabel: "平台", icon: LayoutDashboard },
  { id: "subplatform_admin", label: "子平台管理员", shortLabel: "子管", icon: ShieldCheck },
];

export function App({ initialPath = "/" }: { initialPath?: string }) {
  const [role, setRole] = useState<WorkspaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() => resolveSubplatform(initialPath));
  const [listings] = useState<AssetListing[]>([]);
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

  const selectRole = (nextRole: WorkspaceRole) => {
    setRole(nextRole);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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
            <RoleSwitcher role={role} onChange={selectRole} />
            <div className="header-actions">
              <span className="secure-status"><ShieldCheck size={15} aria-hidden="true" />安全连接</span>
              <IconButton label="通知" onClick={() => setNotice("目前没有新的平台通知") }><Bell size={19} aria-hidden="true" /></IconButton>
              <button className="profile-button" type="button" aria-label="打开个人账户" onClick={() => window.location.assign(`/login?role=${role}&next=${encodeURIComponent(window.location.pathname)}`)}>
                <span><UserRound size={18} aria-hidden="true" /></span>
                <span className="profile-copy"><strong>{subplatform.brandName}</strong><small>{role === "buyer" ? "买家" : role === "seller" ? "卖家" : "管理员"}</small></span>
              </button>
              <IconButton label="打开菜单" onClick={() => setNotice("请使用上方工作台切换，或打开个人账户登录") }><Menu size={20} aria-hidden="true" /></IconButton>
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
              <MatchChat onNotice={setNotice} subplatform={subplatform} />
              {subplatform.pluginArtifact ? (
                <PluginHost role={role} onNotice={setNotice} subplatform={subplatform} fallback={genericWorkspace} />
              ) : genericWorkspace}
            </motion.div>
          </AnimatePresence>
        </main>

        <nav className="mobile-nav" aria-label="工作台切换">
          {roles.map(({ id, shortLabel, icon: Icon }) => (
            <button
              key={id}
              className={role === id ? "is-active" : ""}
              type="button"
              onClick={() => selectRole(id)}
              aria-current={role === id ? "page" : undefined}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{shortLabel}</span>
            </button>
          ))}
        </nav>

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

function RoleSwitcher({ role, onChange }: { role: WorkspaceRole; onChange: (role: WorkspaceRole) => void }) {
  return (
    <div className="role-switcher" role="tablist" aria-label="选择工作台">
      {roles.map(({ id, label }) => (
        <button
          key={id}
          className={role === id ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={role === id}
          onClick={() => onChange(id)}
        >
          {role === id ? <motion.span className="role-indicator" layoutId="role-indicator" /> : null}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
