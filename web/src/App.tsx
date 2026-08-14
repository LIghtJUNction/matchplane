import { useCallback, useEffect, useState } from "react";
import {
  Bell,
  CarFront,
  LayoutDashboard,
  Menu,
  ShieldCheck,
  Store,
  UserRound,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { BuyerDashboard } from "./components/BuyerDashboard";
import { ListingSheet, ModeDialog } from "./components/Overlays";
import { PlatformDashboard } from "./components/PlatformDashboard";
import { Brand, IconButton, spring } from "./components/Primitives";
import { SellerDashboard } from "./components/SellerDashboard";
import { recommendations } from "./data";
import type { VehicleListing, WorkspaceRole } from "./types";

const roles: Array<{ id: WorkspaceRole; label: string; shortLabel: string; icon: typeof CarFront }> = [
  { id: "buyer", label: "买家找车", shortLabel: "找车", icon: CarFront },
  { id: "seller", label: "卖家经营", shortLabel: "卖车", icon: Store },
  { id: "platform", label: "平台管理", shortLabel: "平台", icon: LayoutDashboard },
];

export function App() {
  const [role, setRole] = useState<WorkspaceRole>(() => roleFromLocation());
  const [listing, setListing] = useState<VehicleListing | null>(() => listingFromLocation());
  const [paymentMode, setPaymentMode] = useState<"test" | "production">("test");
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
    const url = new URL(window.location.href);
    url.searchParams.set("role", role);
    window.history.replaceState(null, "", url);
  }, [role]);

  const selectRole = (nextRole: WorkspaceRole) => {
    setRole(nextRole);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const confirmModeChange = () => {
    const nextMode = paymentMode === "test" ? "production" : "test";
    setPaymentMode(nextMode);
    setModeDialogOpen(false);
    setNotice(`支付系统已切换为${nextMode === "test" ? "测试" : "生产"}模式`);
  };

  return (
    <MotionConfig reducedMotion="user" transition={spring}>
      <div id="top" className="app-shell">
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <header className="app-header">
          <div className="header-inner">
            <Brand />
            <RoleSwitcher role={role} onChange={selectRole} />
            <div className="header-actions">
              <span className="secure-status"><ShieldCheck size={15} aria-hidden="true" />安全连接</span>
              <IconButton label="通知"><Bell size={19} aria-hidden="true" /></IconButton>
              <button className="profile-button" type="button" aria-label="打开个人账户">
                <span><UserRound size={18} aria-hidden="true" /></span>
                <span className="profile-copy"><strong>演示账户</strong><small>{role === "buyer" ? "买家" : role === "seller" ? "卖家" : "管理员"}</small></span>
              </button>
              <IconButton label="打开菜单"><Menu size={20} aria-hidden="true" /></IconButton>
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
              {role === "buyer" ? (
                <BuyerDashboard onOpenListing={setListing} onNotice={setNotice} />
              ) : role === "seller" ? (
                <SellerDashboard onNotice={setNotice} />
              ) : (
                <PlatformDashboard
                  paymentMode={paymentMode}
                  onRequestModeChange={() => setModeDialogOpen(true)}
                  onNotice={setNotice}
                />
              )}
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
          onContact={(selected) => {
            closeListing();
            setNotice(`${selected.title} 的联系与看车申请已提交`);
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
  const requested = new URLSearchParams(window.location.search).get("role");
  return requested === "seller" || requested === "platform" ? requested : "buyer";
}

function listingFromLocation(): VehicleListing | null {
  const requested = new URLSearchParams(window.location.search).get("listing");
  return recommendations.find((listing) => listing.id === requested) ?? null;
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
