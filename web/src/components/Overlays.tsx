import { useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
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
import type { SubplatformConfig } from "../subplatform";
import type { InterfaceLocale } from "../lib/preferences";
import { localizedSubplatformCopy } from "../lib/localized-copy";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ListingVisual, momentumSpring, spring } from "./Primitives";

interface ListingSheetProps {
  listing: AssetListing | null;
  subplatform: SubplatformConfig;
  locale: InterfaceLocale;
  onClose: () => void;
  onContact: (listing: AssetListing) => Promise<void> | void;
  onManage?: (listing: AssetListing) => Promise<void> | void;
  /** Contact requests are disabled when the host is running without a live API. */
  contactDisabled?: boolean;
}

export function ListingSheet({
  listing,
  subplatform,
  locale,
  onClose,
  onContact,
  onManage,
  contactDisabled = false,
}: ListingSheetProps) {
  const desktop = useMediaQuery("(min-width: 56rem)");
  const closeRef = useRef<HTMLButtonElement>(null);
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactSubmitted, setContactSubmitted] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const copy = (key: string, fallbackZh: string, fallbackEn: string) =>
    localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);

  useOverlayLifecycle(Boolean(listing), onClose, closeRef);

  useEffect(() => {
    setContactSubmitting(false);
    setContactSubmitted(false);
    setActiveImageIndex(0);
  }, [listing?.id]);

  const images = listing
    ? listing.imageUrls?.length
      ? listing.imageUrls
      : listing.imageUrl
        ? [listing.imageUrl]
        : []
    : [];
  const selectRelativeImage = (offset: number) => {
    if (images.length < 2) return;
    setActiveImageIndex(
      (current) => (current + offset + images.length) % images.length,
    );
  };

  const submitContact = async () => {
    if (!listing || contactSubmitting) return;
    setContactSubmitting(true);
    try {
      await onContact(listing);
      setContactSubmitted(true);
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
            aria-label={copy(
              "closeOfferDetailLabel",
              "关闭供给详情",
              "Close offer details",
            )}
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
              <span className="sheet-label">
                {copy("offerDetailLabel", "供给详情", "Offer details")}
              </span>
              <motion.button
                ref={closeRef}
                type="button"
                aria-label={copy(
                  "closeOfferDetailLabel",
                  "关闭供给详情",
                  "Close offer details",
                )}
                onClick={onClose}
                whileTap={{ scale: 0.88 }}
                transition={spring}
              >
                <X size={20} aria-hidden="true" />
              </motion.button>
            </div>
            <div className="sheet-scroll">
              <div
                className="listing-gallery"
                tabIndex={images.length > 1 ? 0 : -1}
                aria-label={copy("galleryLabel", "商品图片", "Product images")}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") selectRelativeImage(-1);
                  if (event.key === "ArrowRight") selectRelativeImage(1);
                }}
              >
                <ListingVisual
                  accent={listing.accent}
                  label={listing.trust?.[0]}
                  imageUrl={images[activeImageIndex] ?? listing.imageUrl}
                  alt={
                    images.length > 1
                      ? `${listing.title} ${activeImageIndex + 1}/${images.length}`
                      : listing.title
                  }
                />
                {images.length > 1 ? (
                  <>
                    <button
                      className="listing-gallery-arrow is-previous"
                      type="button"
                      aria-label={copy(
                        "previousImageLabel",
                        "上一张图片",
                        "Previous image",
                      )}
                      onClick={() => selectRelativeImage(-1)}
                    >
                      <ChevronLeft size={19} aria-hidden="true" />
                    </button>
                    <button
                      className="listing-gallery-arrow is-next"
                      type="button"
                      aria-label={copy(
                        "nextImageLabel",
                        "下一张图片",
                        "Next image",
                      )}
                      onClick={() => selectRelativeImage(1)}
                    >
                      <ChevronRight size={19} aria-hidden="true" />
                    </button>
                    <span className="listing-gallery-count">
                      {activeImageIndex + 1} / {images.length}
                    </span>
                  </>
                ) : null}
              </div>
              {images.length > 1 ? (
                <div
                  className="listing-gallery-thumbnails"
                  aria-label={copy(
                    "thumbnailLabel",
                    "选择商品图片",
                    "Choose product image",
                  )}
                >
                  {images.map((image, index) => (
                    <button
                      key={image}
                      type="button"
                      aria-label={`${copy("imageLabel", "图片", "Image")} ${index + 1}`}
                      aria-current={
                        index === activeImageIndex ? "true" : undefined
                      }
                      onClick={() => setActiveImageIndex(index)}
                    >
                      <img src={image} alt="" />
                    </button>
                  ))}
                </div>
              ) : null}
              {listing.matchScore !== undefined ? (
                <div className="sheet-match">
                  <Sparkles size={15} aria-hidden="true" />{" "}
                  {matchLevelForScore(listing.matchScore, locale)} ·{" "}
                  {copy("matchLabel", "匹配", "match")}
                </div>
              ) : null}
              <h2 id="listing-sheet-title">{listing.title}</h2>
              <p className="sheet-subtitle">{listing.subtitle}</p>
              {listing.description ? (
                <p className="sheet-description">{listing.description}</p>
              ) : null}
              <div className="sheet-price">
                <strong>{listing.price}</strong>
                {listing.priceLabel ? <span>{listing.priceLabel}</span> : null}
              </div>
              <dl className="sheet-facts">
                {listing.facts.map((fact) => (
                  <div key={`${fact.label}-${fact.value}`}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
                {listing.location ? (
                  <div>
                    <dt>{copy("locationLabel", "位置", "Location")}</dt>
                    <dd>{listing.location}</dd>
                  </div>
                ) : null}
              </dl>

              {listing.reasons?.length ? (
                <section className="sheet-section">
                  <h3>
                    {copy("matchReasonsTitle", "匹配理由", "Why it matches")}
                  </h3>
                  <ul className="reason-list">
                    {listing.reasons.map((reason) => (
                      <li key={reason}>
                        <span>
                          <Check size={14} aria-hidden="true" />
                        </span>
                        {reason}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {listing.risks?.length ? (
                <section className="sheet-section risk-section">
                  <h3>
                    {copy("matchRisksTitle", "需要留意", "Things to consider")}
                  </h3>
                  <ul className="reason-list">
                    {listing.risks.map((risk) => (
                      <li key={risk}>
                        <span>!</span>
                        {risk}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {listing.seller ? (
                <section className="sheet-section trust-section">
                  <div className="seller-line">
                    <span className="seller-avatar">
                      {listing.seller.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{listing.seller}</strong>
                      {listing.response ? (
                        <small>{listing.response}</small>
                      ) : null}
                    </div>
                    <BadgeCheck
                      size={20}
                      aria-label={copy(
                        "verifiedSupplyLabel",
                        "供给方身份已核验",
                        "Supply identity verified",
                      )}
                    />
                  </div>
                  {listing.trust?.length ? (
                    <ul>
                      {listing.trust.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}

              {!onManage ? (
                <section className="offline-contact-card">
                  <span className="contact-icon">
                    <LockKeyhole aria-hidden="true" />
                  </span>
                  <div>
                    <h3>
                      {copy(
                        "contactTitle",
                        "匹配后直接联系供给方",
                        "Contact the supply side after a match",
                      )}
                    </h3>
                    <p>
                      {copy(
                        "contactDescription",
                        "平台确认撮合与服务安排后，双方联系方式按权限解锁；后续可以在线下完成。",
                        "Contact details unlock after the platform confirms the match and arrangements; you can continue offline.",
                      )}
                    </p>
                  </div>
                  <div className="contact-options">
                    <span>
                      <MessageCircle size={15} aria-hidden="true" />
                      {copy(
                        "inPlatformContactLabel",
                        "站内沟通",
                        "In-platform chat",
                      )}
                    </span>
                    <span>
                      <Phone size={15} aria-hidden="true" />
                      {copy(
                        "contactChannelsLabel",
                        "联系方式",
                        "Contact channels",
                      )}
                    </span>
                    <span>
                      <CalendarDays size={15} aria-hidden="true" />
                      {copy("appointmentLabel", "预约协商", "Arrange a time")}
                    </span>
                    <span>
                      <MapPin size={15} aria-hidden="true" />
                      {copy("locationLabel", "地点受控", "Location controlled")}
                    </span>
                  </div>
                </section>
              ) : null}
            </div>
            <div className={`sheet-footer${onManage ? " is-owner" : ""}`}>
              {!onManage ? (
                <div>
                  {contactSubmitted ? (
                    <small className="sheet-contact-success" role="status">
                      {copy(
                        "contactSubmittedLabel",
                        "联系申请已发送，等待供给方同意",
                        "Contact request sent; waiting for the supply side",
                      )}
                    </small>
                  ) : (
                    <>
                      <small>
                        {copy(
                          "platformFeeLabel",
                          "商城服务费",
                          "Mall service fee",
                        )}
                      </small>
                      <strong>
                        {copy(
                          "platformFeeDescription",
                          "按当前店铺披露规则结算",
                          "Settled under the active store disclosure",
                        )}
                      </strong>
                    </>
                  )}
                </div>
              ) : null}
              <motion.button
                className="button button-dark"
                type="button"
                onClick={() =>
                  onManage ? void onManage(listing) : void submitContact()
                }
                disabled={
                  !onManage &&
                  (contactSubmitting || contactSubmitted || contactDisabled)
                }
                title={
                  contactDisabled
                    ? copy(
                        "contactUnavailableTitle",
                        "当前环境未连接真实撮合 API",
                        "The live matching API is not connected",
                      )
                    : undefined
                }
                whileTap={{ scale: 0.97 }}
                transition={momentumSpring}
              >
                {onManage
                  ? copy("manageProductLabel", "管理商品", "Manage product")
                  : contactSubmitting
                    ? copy("contactSubmittingLabel", "正在提交…", "Submitting…")
                    : contactSubmitted
                      ? copy("contactSubmittedButton", "已发送", "Sent")
                      : contactDisabled
                        ? copy(
                            "contactUnavailableLabel",
                            "当前暂不可用",
                            "Unavailable right now",
                          )
                        : copy(
                            "requestContactLabel",
                            "申请联系",
                            "Request contact",
                          )}
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

function matchLevelForScore(score: number, locale: InterfaceLocale): string {
  if (locale === "en")
    return score >= 80
      ? "Strong fit"
      : score >= 60
        ? "Good fit"
        : score >= 40
          ? "Possible fit"
          : "Weak fit";
  return score >= 80
    ? "非常适合"
    : score >= 60
      ? "比较适合"
      : score >= 40
        ? "一般"
        : "不太适合";
}

export function ModeDialog({
  open,
  currentMode,
  onClose,
  onConfirm,
  resourceLabel = "",
}: ModeDialogProps) {
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
            <span className="dialog-icon">
              <ShieldCheck aria-hidden="true" />
            </span>
            <p className="eyebrow">运营操作</p>
            <h2 id="mode-dialog-title">
              切换{resourceLabel ? `${resourceLabel}到` : "到"}
              {target}？
            </h2>
            <p>
              切换前系统会检查目标模式的配置，并阻止存在未知结果时切换。
              所有配置变更都会写入审计日志。
            </p>
            <div className="dialog-checks">
              <span>
                <Check size={15} aria-hidden="true" />
                网关路由检查
              </span>
              <span>
                <Check size={15} aria-hidden="true" />
                未决订单检查
              </span>
              <span>
                <Check size={15} aria-hidden="true" />
                乐观版本校验
              </span>
            </div>
            <div className="dialog-actions">
              <button
                ref={closeRef}
                className="button button-quiet"
                type="button"
                onClick={onClose}
              >
                取消
              </button>
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
