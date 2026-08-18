import { useEffect, useRef, useState } from "react";
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

import type { AssetListing } from "../types";
import { subplatformCopy, type SubplatformConfig } from "../subplatform";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ListingVisual, momentumSpring, spring } from "./Primitives";

interface ListingSheetProps {
  listing: AssetListing | null;
  subplatform: SubplatformConfig;
  onClose: () => void;
  onContact: (listing: AssetListing) => Promise<void> | void;
  /** Contact requests are disabled when the host is running without a live API. */
  contactDisabled?: boolean;
}

export function ListingSheet({ listing, subplatform, onClose, onContact, contactDisabled = false }: ListingSheetProps) {
  const desktop = useMediaQuery("(min-width: 56rem)");
  const closeRef = useRef<HTMLButtonElement>(null);
  const [contactSubmitting, setContactSubmitting] = useState(false);

  useOverlayLifecycle(Boolean(listing), onClose, closeRef);

  useEffect(() => {
    if (!listing) setContactSubmitting(false);
  }, [listing]);

  const submitContact = async () => {
    if (!listing || contactSubmitting) return;
    setContactSubmitting(true);
    try {
      await onContact(listing);
    } finally {
      setContactSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {listing ? (
        <div className="overlay-layer">
          <motion.button
            className="overlay-backdrop"
            type="button"
            aria-label="关闭供给详情"
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
              <span className="sheet-label">{subplatformCopy(subplatform, "offerDetailLabel", "供给详情")}</span>
              <motion.button
                ref={closeRef}
                type="button"
                aria-label="关闭供给详情"
                onClick={onClose}
                whileTap={{ scale: 0.88 }}
                transition={spring}
              >
                <X size={20} aria-hidden="true" />
              </motion.button>
            </div>
            <div className="sheet-scroll">
              <ListingVisual accent={listing.accent} label={listing.trust?.[0]} />
              {listing.matchScore !== undefined ? <div className="sheet-match"><Sparkles size={15} aria-hidden="true" /> {matchLevelForScore(listing.matchScore)} · {subplatformCopy(subplatform, "matchLabel", "匹配")}</div> : null}
              <h2 id="listing-sheet-title">{listing.title}</h2>
              <p className="sheet-subtitle">{listing.subtitle}</p>
              <div className="sheet-price"><strong>{listing.price}</strong>{listing.priceLabel ? <span>{listing.priceLabel}</span> : null}</div>
              <dl className="sheet-facts">
                {listing.facts.map((fact) => <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
                {listing.location ? <div><dt>位置</dt><dd>{listing.location}</dd></div> : null}
              </dl>

              {listing.reasons?.length ? <section className="sheet-section">
                <h3>匹配理由</h3>
                <ul className="reason-list">
                  {listing.reasons.map((reason) => (
                    <li key={reason}><span><Check size={14} aria-hidden="true" /></span>{reason}</li>
                  ))}
                </ul>
              </section> : null}

              {listing.risks?.length ? <section className="sheet-section risk-section">
                <h3>需要留意</h3>
                <ul className="reason-list">
                  {listing.risks.map((risk) => (
                    <li key={risk}><span>!</span>{risk}</li>
                  ))}
                </ul>
              </section> : null}

              {listing.seller ? <section className="sheet-section trust-section">
                <div className="seller-line">
                  <span className="seller-avatar">{listing.seller.slice(0, 1)}</span>
                  <div><strong>{listing.seller}</strong>{listing.response ? <small>{listing.response}</small> : null}</div>
                  <BadgeCheck size={20} aria-label={subplatformCopy(subplatform, "verifiedSupplyLabel", "供给方身份已核验")} />
                </div>
                {listing.trust?.length ? <ul>{listing.trust.map((item) => <li key={item}>{item}</li>)}</ul> : null}
              </section> : null}

              <section className="offline-contact-card">
                <span className="contact-icon"><LockKeyhole aria-hidden="true" /></span>
                <div>
                  <h3>{subplatformCopy(subplatform, "contactTitle", "匹配后直接联系供给方")}</h3>
                  <p>{subplatformCopy(subplatform, "contactDescription", "平台确认撮合与服务安排后，双方联系方式按权限解锁；后续可以在线下完成。")}</p>
                </div>
                <div className="contact-options">
                  <span><MessageCircle size={15} aria-hidden="true" />站内沟通</span>
                  <span><Phone size={15} aria-hidden="true" />{subplatformCopy(subplatform, "contactChannelsLabel", "联系方式")}</span>
                  <span><CalendarDays size={15} aria-hidden="true" />{subplatformCopy(subplatform, "appointmentLabel", "预约协商")}</span>
                  <span><MapPin size={15} aria-hidden="true" />{subplatformCopy(subplatform, "locationLabel", "地点受控")}</span>
                </div>
              </section>
            </div>
            <div className="sheet-footer">
              <div><small>{subplatformCopy(subplatform, "platformFeeLabel", "平台服务费")}</small><strong>{subplatformCopy(subplatform, "platformFeeDescription", "按当前子平台披露规则结算")}</strong></div>
              <motion.button
                className="button button-dark"
                type="button"
                onClick={() => void submitContact()}
                disabled={contactSubmitting || contactDisabled}
                title={contactDisabled ? "当前环境未连接真实撮合 API" : undefined}
                whileTap={{ scale: 0.97 }}
                transition={momentumSpring}
              >
                {contactSubmitting
                  ? subplatformCopy(subplatform, "contactSubmittingLabel", "正在提交…")
                  : contactDisabled
                    ? subplatformCopy(subplatform, "contactUnavailableLabel", "当前暂不可用")
                    : subplatformCopy(subplatform, "requestContactLabel", "申请联系")}
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
  resourceLabel?: string;
}

function matchLevelForScore(score: number): string {
  return score >= 80 ? "非常适合" : score >= 60 ? "比较适合" : score >= 40 ? "一般" : "不太适合";
}

export function ModeDialog({ open, currentMode, onClose, onConfirm, resourceLabel = "" }: ModeDialogProps) {
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
            aria-label={`取消切换${resourceLabel || "支付"}模式`}
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
            <h2 id="mode-dialog-title">切换{resourceLabel ? `${resourceLabel}到` : "到"}{target}？</h2>
            <p>
              切换前系统会检查目标模式的配置，并阻止存在未知结果时切换。
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
