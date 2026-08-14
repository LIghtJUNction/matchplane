import { useEffect, useRef } from "react";
import {
  BadgeCheck,
  CalendarDays,
  Check,
  LockKeyhole,
  MapPin,
  MessageCircle,
  Phone,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { VehicleListing } from "../types";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { VehicleVisual, momentumSpring, spring } from "./Primitives";

interface ListingSheetProps {
  listing: VehicleListing | null;
  onClose: () => void;
  onContact: (listing: VehicleListing) => void;
}

export function ListingSheet({ listing, onClose, onContact }: ListingSheetProps) {
  const desktop = useMediaQuery("(min-width: 56rem)");
  const closeRef = useRef<HTMLButtonElement>(null);

  useOverlayLifecycle(Boolean(listing), onClose, closeRef);

  return (
    <AnimatePresence>
      {listing ? (
        <div className="overlay-layer">
          <motion.button
            className="overlay-backdrop"
            type="button"
            aria-label="关闭车辆详情"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.aside
            className="listing-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="listing-sheet-title"
            initial={desktop ? { x: "100%" } : { y: "100%" }}
            animate={desktop ? { x: 0 } : { y: 0 }}
            exit={desktop ? { x: "100%" } : { y: "100%" }}
            transition={spring}
            drag={desktop ? false : "y"}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.42 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 700) onClose();
            }}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <span className="sheet-label">车辆详情</span>
              <motion.button
                ref={closeRef}
                type="button"
                aria-label="关闭车辆详情"
                onClick={onClose}
                whileTap={{ scale: 0.88 }}
                transition={spring}
              >
                <X size={20} aria-hidden="true" />
              </motion.button>
            </div>
            <div className="sheet-scroll">
              <VehicleVisual accent={listing.accent} />
              <div className="sheet-match"><Sparkles size={15} aria-hidden="true" /> {listing.matchScore}% 需求匹配</div>
              <h2 id="listing-sheet-title">{listing.title}</h2>
              <p className="sheet-subtitle">{listing.subtitle}</p>
              <div className="sheet-price"><strong>{listing.price}</strong><span>{listing.monthly}</span></div>
              <dl className="sheet-facts">
                <div><dt>里程</dt><dd>{listing.mileage}</dd></div>
                <div><dt>能源</dt><dd>{listing.energy}</dd></div>
                <div><dt>年份</dt><dd>{listing.year}</dd></div>
                <div><dt>位置</dt><dd>{listing.location}</dd></div>
              </dl>

              <section className="sheet-section">
                <h3>为什么适合你</h3>
                <ul className="reason-list">
                  {listing.reasons.map((reason) => (
                    <li key={reason}><span><Check size={14} aria-hidden="true" /></span>{reason}</li>
                  ))}
                </ul>
              </section>

              <section className="sheet-section trust-section">
                <div className="seller-line">
                  <span className="seller-avatar">{listing.seller.slice(0, 1)}</span>
                  <div><strong>{listing.seller}</strong><small>{listing.response}</small></div>
                  <BadgeCheck size={20} aria-label="卖家身份已核验" />
                </div>
                <ul>
                  {listing.trust.map((item) => <li key={item}><ShieldCheck size={15} aria-hidden="true" />{item}</li>)}
                </ul>
              </section>

              <section className="offline-contact-card">
                <span className="contact-icon"><LockKeyhole aria-hidden="true" /></span>
                <div>
                  <h3>匹配后直接联系卖家</h3>
                  <p>平台确认撮合与提成安排后，双方联系方式按权限解锁；整车款可在线下当面结算。</p>
                </div>
                <div className="contact-options">
                  <span><MessageCircle size={15} aria-hidden="true" />站内沟通</span>
                  <span><Phone size={15} aria-hidden="true" />电话 / 微信</span>
                  <span><CalendarDays size={15} aria-hidden="true" />预约看车</span>
                  <span><MapPin size={15} aria-hidden="true" />地点加密</span>
                </div>
              </section>
            </div>
            <div className="sheet-footer">
              <div><small>平台撮合提成</small><strong>成交价的 1%，成交后收取</strong></div>
              <motion.button
                className="button button-dark"
                type="button"
                onClick={() => onContact(listing)}
                whileTap={{ scale: 0.97 }}
                transition={momentumSpring}
              >
                申请联系并看车
              </motion.button>
            </div>
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

interface ModeDialogProps {
  open: boolean;
  currentMode: "test" | "production";
  onClose: () => void;
  onConfirm: () => void;
}

export function ModeDialog({ open, currentMode, onClose, onConfirm }: ModeDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const target = currentMode === "test" ? "生产模式" : "测试模式";
  useOverlayLifecycle(open, onClose, closeRef);

  return (
    <AnimatePresence>
      {open ? (
        <div className="overlay-layer dialog-layer">
          <motion.button
            className="overlay-backdrop"
            type="button"
            aria-label="取消切换支付模式"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.section
            className="mode-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mode-dialog-title"
            initial={{ opacity: 0, scale: 0.92, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 10 }}
            transition={spring}
          >
            <span className="dialog-icon"><ShieldCheck aria-hidden="true" /></span>
            <p className="eyebrow">管理员操作</p>
            <h2 id="mode-dialog-title">切换到{target}？</h2>
            <p>
              切换前系统会检查目标模式至少有一个可用网关，并阻止存在未知支付结果时切换。
              所有配置变更都会写入审计日志。
            </p>
            <div className="dialog-checks">
              <span><Check size={15} aria-hidden="true" />网关路由检查</span>
              <span><Check size={15} aria-hidden="true" />未决订单检查</span>
              <span><Check size={15} aria-hidden="true" />乐观版本校验</span>
            </div>
            <div className="dialog-actions">
              <button ref={closeRef} className="button button-quiet" type="button" onClick={onClose}>取消</button>
              <motion.button
                className="button button-dark"
                type="button"
                onClick={onConfirm}
                whileTap={{ scale: 0.97 }}
                transition={spring}
              >
                确认切换
              </motion.button>
            </div>
          </motion.section>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function useOverlayLifecycle(
  open: boolean,
  onClose: () => void,
  focusRef: React.RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    const frame = window.requestAnimationFrame(() => focusRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [focusRef, onClose, open]);
}
