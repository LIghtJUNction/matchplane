import { Button } from "@appica/ui-react/button";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@appica/ui-react/drawer";
import { useMediaQuery } from "@appica/ui-react/hooks/use-media-query";
import { Check, ChevronLeft, ChevronRight, LockKeyhole, X } from "lucide-react";
import { useEffect, useState } from "react";

import { localizedSubplatformCopy } from "../lib/localized-copy";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { ListingVisual } from "./Primitives";

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
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactSubmitted, setContactSubmitted] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const copy = (key: string, fallbackZh: string, fallbackEn: string) =>
    localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);

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
    } catch {
      // Host surfaces the failure notice; keep the sheet actionable.
    } finally {
      setContactSubmitting(false);
    }
  };

  return (
    <Drawer
      side={desktop ? "right" : "bottom"}
      open={Boolean(listing)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {listing ? (
        <DrawerContent
          className="listing-sheet"
          closeButton={false}
          closeLabel={copy(
            "closeOfferDetailLabel",
            "关闭供给详情",
            "Close offer details",
          )}
          frame={false}
        >
          <DrawerHeader className="sheet-header">
            <span className="sheet-label">
              {copy("offerDetailLabel", "供给详情", "Offer details")}
            </span>
            <DrawerDescription className="sr-only">
              {listing.subtitle ||
                copy(
                  "offerDetailDescription",
                  "查看商品信息并申请联系",
                  "Review product details and request contact",
                )}
            </DrawerDescription>
            <DrawerClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="sheet-close"
                  type="button"
                  aria-label={copy(
                    "closeOfferDetailLabel",
                    "关闭供给详情",
                    "Close offer details",
                  )}
                >
                  <X size={20} aria-hidden="true" />
                </Button>
              }
            />
          </DrawerHeader>
          <DrawerBody className="sheet-scroll">
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
            <DrawerTitle id="listing-sheet-title">{listing.title}</DrawerTitle>
            <p className="sheet-subtitle">{listing.subtitle}</p>
            <div className="sheet-price">
              <strong>{listing.price}</strong>
              {listing.priceLabel ? <span>{listing.priceLabel}</span> : null}
            </div>
            {listing.facts.length || listing.location ? (
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
            ) : null}
            {listing.description ? (
              <p className="sheet-description">{listing.description}</p>
            ) : null}

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

            {listing.providerHints?.length ? (
              <section className="sheet-section provider-hint-section">
                <h3>
                  {copy(
                    "storeRetrievalHintsTitle",
                    "店铺检索线索",
                    "Store retrieval hints",
                  )}
                </h3>
                <ul className="provider-hint-list">
                  {listing.providerHints.map((hint) => (
                    <li key={hint}>{hint}</li>
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
                </div>
              </section>
            ) : null}

            {onManage ? null : (
              <section className="offline-contact-card">
                <span className="contact-icon">
                  <LockKeyhole aria-hidden="true" />
                </span>
                <div>
                  <h3>
                    {copy(
                      "contactTitle",
                      "申请联系需双方同意",
                      "Contact needs mutual consent",
                    )}
                  </h3>
                  <p>
                    {copy(
                      "contactDescription",
                      "提交后只写入撮合申请。只有双方明确同意后，才解锁已验证的联系方式。",
                      "This only records a match request. Verified contact details unlock only after both sides explicitly agree.",
                    )}
                  </p>
                </div>
              </section>
            )}
          </DrawerBody>
          <DrawerFooter
            className={`sheet-footer${onManage ? " is-owner" : ""}`}
          >
            {onManage ? null : (
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
                  <small>
                    {copy(
                      "contactFooterHint",
                      "不会自动交换电话或微信",
                      "Phone and WeChat are never shared automatically",
                    )}
                  </small>
                )}
              </div>
            )}
            <Button
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
            </Button>
          </DrawerFooter>
        </DrawerContent>
      ) : null}
    </Drawer>
  );
}
