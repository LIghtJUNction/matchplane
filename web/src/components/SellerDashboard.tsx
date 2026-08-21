"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, FileUp, Trash2 } from "lucide-react";
import { motion } from "motion/react";

import {
  consentMarketplaceContact,
  createMarketplaceOffer,
  getMarketplaceIntroductions,
  getMarketplaceDemandMatches,
  getMarketplaceOffers,
  getSellerListingSubmissions,
  isLiveMarketplaceEnabled,
  uploadMarketplaceAttachment,
  retrieveMarketplaceContact,
  type MarketplaceIntroduction,
  type MarketplaceDemandCandidate,
  type MarketplaceContactResponse,
  type MarketplaceOffer,
  submitSellerListing,
  type ListingSubmission,
  type MarketplaceAttachment,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import { localizedSubplatformCopy } from "../lib/localized-copy";
import { pricingFor, subplatformContactLabel, type SubplatformConfig } from "../subplatform";
import { SectionHeading, spring } from "./Primitives";
import { ContactProfileCard } from "./ContactProfileCard";

interface SellerDashboardProps {
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
  agentDraft?: {
    narrative: string;
    intentId?: string;
    attributes: Record<string, unknown>;
    terms: Record<string, unknown>;
    attachments?: MarketplaceAttachment[];
  } | null;
}

type SellerRecord = ListingSubmission | MarketplaceOffer;
type SellerPanel = "details" | "history" | "demand" | "contacts";

const sellerEnglishFallbacks: Record<string, string> = {
  supplyWorkspaceLabel: "Supply workspace",
  currentPlatformLabel: "Current platform",
  supplyTitle: "Upload real information and let the platform find the right demand.",
  supplyDescription: "The root platform does not seed sample content. Submissions enter review before matching.",
  identityProtectionLabel: "Your account and contact details stay protected by the root platform",
  supplyStatusLabel: "Supply status",
  submittedPrefix: "Submitted",
  submittedSuffix: "items",
  noSubmissionsLabel: "No items submitted yet",
  submissionWorkflowLabel: "Submissions enter this platform's review workflow",
  uploadEyebrow: "Upload",
  uploadTitle: "Submit a new offer",
  uploadDescription: "Add a product image, name, description, and price. The mall reviews it before it appears in search.",
  offerNameLabel: "Offer name",
  offerNamePlaceholder: "Describe it yourself",
  externalKeyLabel: "Internal reference",
  externalKeyPlaceholder: "Leave blank to generate one",
  priceLabel: "Price",
  priceMinLabel: "Minimum price",
  priceMaxLabel: "Maximum price",
  currencyLabel: "Currency",
  currencyPlaceholder: "Waiting for platform configuration",
  pricingNoteLabel: "Negotiation terms",
  pricingNotePlaceholder: "Explain the price, terms, or negotiable range",
  advancedAttributesLabel: "Advanced attributes (JSON)",
  reviewNotice: "New submissions start in review; the platform will not publish unconfirmed information.",
  submittingLabel: "Submitting…",
  submitForReviewLabel: "Submit for review",
  submissionHistoryEyebrow: "Submission history",
  submissionHistoryTitle: "Your offers on this platform",
  noSubmissionHistoryLabel: "No uploads yet. Define your first offer.",
  demandDiscoveryEyebrow: "Matching",
  demandDiscoveryTitle: "Find published demand",
  demandDiscoveryDescription: "Only people who opted in to discovery appear here. Contact details are exchanged only after both sides agree.",
  contactRequestsEyebrow: "Contact requests",
  contactRequestsTitle: "Both sides must agree before contact details are exchanged",
  contactRequestLabel: "A matching contact request",
  contactVisibleLabel: "Ready to contact",
  contactReadingLabel: "Loading…",
  viewContactLabel: "View contact details",
  processingLabel: "Processing…",
  consentContactLabel: "Agree to exchange",
  noContactRequestsLabel: "No pending contact requests.",
  contactLoginNotice: "Sign in to view contact details after both sides agree",
  contactReleasedNotice: "Contact details are unlocked; use the channel provided",
  contactReleaseError: "Contact details are temporarily unavailable",
};

/** Generic seller surface. The active subplatform owns the meaning of `attributes`. */
export function SellerDashboard({ locale, onNotice, subplatform, agentDraft = null }: SellerDashboardProps) {
  const [externalKey, setExternalKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [category, setCategory] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"" | "digital" | "shipping" | "service">("");
  const [stockQuantity, setStockQuantity] = useState("1");
  const [productDescription, setProductDescription] = useState("");
  const [askingAmount, setAskingAmount] = useState("");
  const pricing = pricingFor(subplatform);
  const copy = (key: string, fallbackZh: string, fallbackEn = sellerEnglishFallbacks[key] ?? fallbackZh) => localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);
  const usesLegacyMarketplace = subplatform.marketplaceContract === "legacy-v1";
  const pricingCurrency = pricing.currency ?? subplatform.currency ?? "CNY";
  const pricingScale = pricing.currencyScale ?? subplatform.currencyScale ?? 2;
  const [currency, setCurrency] = useState(pricingCurrency ?? "");
  const [draftImported, setDraftImported] = useState(false);
  const [attachments, setAttachments] = useState<MarketplaceAttachment[]>([]);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<SellerRecord[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [introductions, setIntroductions] = useState<MarketplaceIntroduction[]>([]);
  const [introductionsError, setIntroductionsError] = useState<string | null>(null);
  const [demandMatches, setDemandMatches] = useState<Record<string, MarketplaceDemandCandidate[]>>({});
  const [demandMatchesLoading, setDemandMatchesLoading] = useState<Record<string, boolean>>({});
  const [demandMatchesError, setDemandMatchesError] = useState<Record<string, string>>({});
  const [consentingIntroductionId, setConsentingIntroductionId] = useState<string | null>(null);
  const [releasedContacts, setReleasedContacts] = useState<Record<string, MarketplaceContactResponse>>({});
  const [releasingContactId, setReleasingContactId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<SellerPanel>("history");

  const loadSubmissions = useCallback(async () => {
    setSubmissions([]);
    setIntroductions([]);
    setSubmissionsError(null);
    setIntroductionsError(null);
    setDemandMatches({});
    setDemandMatchesLoading({});
    setDemandMatchesError({});
    if (!isLiveMarketplaceEnabled()) {
      setSubmissionsError(copy("supplyApiUnavailable", "当前部署未启用真实供给 API", "The live supply API is not enabled for this deployment"));
      return;
    }
    if (!subplatform.domainId || !subplatform.tenantId) {
      setSubmissionsError(copy("platformIdentityIncomplete", "当前店铺还没有完成身份配置", "This store has not finished its identity setup"));
      return;
    }
    setSubmissionsLoading(true);
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "seller",
      });
      if (!session) {
        setSubmissionsError(copy("signInToViewSubmissions", "请先登录后查看你的提交记录", "Sign in to view your submissions"));
        return;
      }
      if (usesLegacyMarketplace) {
        setSubmissions(await getSellerListingSubmissions({ session, domainId: subplatform.domainId }));
      } else {
        setSubmissions(await getMarketplaceOffers({ session, domainId: subplatform.domainId }));
      }
      setIntroductions(await getMarketplaceIntroductions({ session, domainId: subplatform.domainId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : copy("submissionLoadError", "提交记录读取失败", "Could not load submissions");
      setSubmissionsError(message);
      setIntroductionsError(message);
    } finally {
      setSubmissionsLoading(false);
    }
  }, [subplatform.domainId, subplatform.marketplaceContract, subplatform.path, subplatform.slug, subplatform.tenantId, usesLegacyMarketplace]);

  const findDemandMatches = async (record: MarketplaceOffer) => {
    if (!subplatform.domainId || !subplatform.tenantId) return;
    setDemandMatchesLoading((current) => ({ ...current, [record.offer_id]: true }));
    setDemandMatchesError((current) => {
      const next = { ...current };
      delete next[record.offer_id];
      return next;
    });
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "seller",
      });
      if (!session) {
        onNotice(copy("signInToFindDemand", "请先登录后寻找已公开需求", "Sign in to find published demand"));
        return;
      }
      const matches = await getMarketplaceDemandMatches({
        session,
        domainId: subplatform.domainId,
        offerId: record.offer_id,
        limit: 12,
      });
      setDemandMatches((current) => ({ ...current, [record.offer_id]: matches }));
    } catch (error) {
      const message = error instanceof Error ? error.message : copy("demandMatchLoadError", "需求匹配暂时无法读取", "Demand matching is temporarily unavailable");
      setDemandMatchesError((current) => ({ ...current, [record.offer_id]: message }));
    } finally {
      setDemandMatchesLoading((current) => ({ ...current, [record.offer_id]: false }));
    }
  };

  const consent = async (introduction: MarketplaceIntroduction) => {
    if (!subplatform.domainId || consentingIntroductionId) return;
    setConsentingIntroductionId(introduction.introduction_id);
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "seller",
      });
      if (!session) {
        onNotice(copy("signInToProcessContact", "请先登录后处理联系申请", "Sign in to process contact requests"));
        return;
      }
      const updated = await consentMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
      });
      setIntroductions((current) => current.map((item) => item.introduction_id === updated.introduction_id ? updated : item));
      onNotice(copy("contactConsentSaved", "已同意交换联系方式，买方可以查看你提供的联系渠道", "Contact exchange approved; the buyer can view your channels"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("contactConsentError", "联系申请处理失败", "Could not process the contact request"));
    } finally {
      setConsentingIntroductionId(null);
    }
  };

  const releaseContact = async (introduction: MarketplaceIntroduction) => {
    if (!subplatform.domainId || releasingContactId) return;
    setReleasingContactId(introduction.introduction_id);
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "seller",
      });
      if (!session) {
        onNotice(copy("contactLoginNotice", "请先登录后查看已同意交换的联系方式"));
        return;
      }
      const contact = await retrieveMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
      });
      setReleasedContacts((current) => ({ ...current, [introduction.introduction_id]: contact }));
      onNotice(copy("contactReleasedNotice", "联系方式已解锁，请通过对方提供的渠道联系"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("contactReleaseError", "联系方式暂时无法读取"));
    } finally {
      setReleasingContactId(null);
    }
  };

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  useEffect(() => {
    setCurrency(pricingCurrency ?? "");
  }, [pricingCurrency]);

  useEffect(() => {
    setDraftImported(false);
  }, [agentDraft?.intentId, agentDraft?.narrative]);

  useEffect(() => {
    if (usesLegacyMarketplace && activePanel === "demand") setActivePanel("details");
  }, [activePanel, usesLegacyMarketplace]);

  const importAgentDraft = () => {
    if (!agentDraft) return;
    setProductDescription(agentDraft.narrative);
    if (agentDraft.attachments?.length) setAttachments(agentDraft.attachments.slice(0, 8));
    setDraftImported(true);
    onNotice(copy("agentDraftImportedNotice", "已把对话草稿放入商品描述，请检查后提交", "The conversation draft was added to the product description"));
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || !files.length || mediaUploading) return;
    if (!subplatform.tenantId || !subplatform.domainId) {
      onNotice(copy("platformIdentityIncompleteNotice", "当前店铺尚未完成身份配置", "This store's identity configuration is incomplete"));
      return;
    }
    const remaining = Math.max(0, 8 - attachments.length);
    if (!remaining) {
      onNotice(copy("mediaLimitNotice", "最多添加 8 个附件", "You can add up to 8 attachments"));
      return;
    }
    setMediaUploading(true);
    try {
      const uploaded: MarketplaceAttachment[] = [];
      for (const file of Array.from(files).slice(0, remaining)) {
        uploaded.push(await uploadMarketplaceAttachment({
          platformPath: subplatform.path,
          tenantId: subplatform.tenantId,
          domainId: subplatform.domainId,
          file,
        }));
      }
      setAttachments((current) => [...current, ...uploaded].slice(0, 8));
      if (files.length > remaining) onNotice(copy("mediaLimitNotice", "最多添加 8 个附件", "You can add up to 8 attachments"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("mediaUploadError", "附件上传失败，请稍后重试", "Could not upload the attachment; try again"));
    } finally {
      setMediaUploading(false);
    }
  };

  const publishedOffers = useMemo(
    () => submissions.filter(isMarketplaceOffer).filter((offer) => offer.status === "active"),
    [submissions],
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = displayName.trim();
    const normalizedCategory = category.trim();
    const normalizedKey = externalKey.trim() || `offer-${crypto.randomUUID()}`;
    const normalizedCurrency = currency.trim().toUpperCase();
    const normalizedAmount = toMinorUnits(askingAmount, pricingScale);
    const normalizedStock = Number.parseInt(stockQuantity, 10);
    if (!isLiveMarketplaceEnabled()) {
      onNotice(copy("supplyApiUnavailableNotice", "当前环境未启用真实供给 API，资料没有写入系统", "The live supply API is disabled; nothing was saved"));
      return;
    }
    if (!normalizedName || !normalizedCategory || !deliveryMode || !productDescription.trim() || !askingAmount.trim() || !attachments.length) {
      onNotice(copy("productRequired", "请填写商品名称、分类、描述、价格、交付方式并上传商品图片", "Enter a product name, category, description, price, delivery mode, and product image"));
      return;
    }
    if (!Number.isSafeInteger(normalizedStock) || normalizedStock < 0 || normalizedStock > 1_000_000) {
      onNotice(copy("invalidProductStock", "库存必须是 0 到 1000000 之间的整数", "Stock must be an integer between 0 and 1000000"));
      return;
    }
    if (!normalizedAmount) {
      onNotice(copy("invalidProductPrice", "请填写有效的商品价格", "Enter a valid product price"));
      return;
    }
    if (!subplatform.domainId) {
      onNotice(copy("platformIdentityIncompleteNotice", "当前店铺尚未完成身份配置", "This store has not finished its identity setup"));
      return;
    }
    if (usesLegacyMarketplace && (!subplatform.assetSchemaId || !pricingCurrency
      || typeof pricingScale !== "number"
      || !Number.isInteger(pricingScale)
      || pricingScale < 0 || pricingScale > 18)) {
      onNotice(copy("platformSchemaIncomplete", "当前店铺尚未配置完整的商品字段、币种和价格精度", "This store has incomplete product fields, currency, or price precision settings"));
      return;
    }
    const parsedAttributes: Record<string, unknown> = {
      description: productDescription.trim(),
      category: normalizedCategory,
      delivery_mode: deliveryMode,
      stock_quantity: normalizedStock,
    };
    const attributesWithAttachments = attachments.length
      ? { ...parsedAttributes, attachments: attachments.map(publicAttachment) }
      : parsedAttributes;

    let session: Awaited<ReturnType<typeof getMarketplaceSession>> = null;
    try {
      session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "seller",
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("platformSessionError", "当前店铺身份配置不完整", "This store's identity configuration is incomplete"));
      return;
    }
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    setSubmitting(true);
    try {
      let record: SellerRecord;
      if (usesLegacyMarketplace) {
        record = await submitSellerListing({
          session,
          domainId: subplatform.domainId,
          assetSchemaId: subplatform.assetSchemaId as string,
          externalKey: normalizedKey,
          displayName: normalizedName,
          attributes: attributesWithAttachments,
          askingAmount: normalizedAmount,
          currency: normalizedCurrency,
          currencyScale: pricingScale as number,
        });
      } else {
        const offer = await createMarketplaceOffer({
          session,
          domainId: subplatform.domainId,
          externalKey: normalizedKey,
          displayName: normalizedName,
          attributes: attributesWithAttachments,
          terms: {
            pricing_mode: "fixed",
            amount_minor: normalizedAmount,
            currency: normalizedCurrency,
            currency_scale: pricingScale,
          },
        });
        record = offer;
      }
      setSubmissions((current) => [record, ...current]);
      setExternalKey("");
      setDisplayName("");
      setCategory("");
      setDeliveryMode("");
      setStockQuantity("1");
      setProductDescription("");
      setAskingAmount("");
      setCurrency(pricingCurrency ?? "");
      setAttachments([]);
      setActivePanel("history");
      onNotice(copy("offerSubmittedNotice", "供给已提交，等待平台审核后展示", "Offer submitted; it will appear after platform review"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("offerSubmitError", "供给提交失败，请稍后重试", "Could not submit the offer; try again"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dashboard seller-dashboard">
      <div className="seller-settings-summary">
        <div>
          <strong>{subplatform.label || copy("currentPlatformLabel", "当前店铺")}</strong>
          <span>{submissions.length ? `${submissions.length} 件商品` : copy("noSubmissionsLabel", "还没有商品")}</span>
        </div>
        <div className="seller-summary-actions"><span className="seller-mode-note">{copy("identityProtectionLabel", "账号和联系方式由商城保护")}</span><button className="button button-dark" type="button" onClick={() => setActivePanel("details")}>发布商品<ArrowRight size={16} aria-hidden="true" /></button></div>
      </div>

      <nav className="seller-settings-nav" role="tablist" aria-label={copy("sellerSettingsSectionsLabel", "供给设置分区", "Supply settings sections")}>
        <button type="button" role="tab" aria-selected={activePanel === "history"} aria-controls="seller-panel-history" className={activePanel === "history" ? "is-active" : ""} onClick={() => setActivePanel("history")}>{copy("sellerHistoryTab", "商品列表", "Products")}<span>{submissions.length}</span></button>
        <button type="button" role="tab" aria-selected={activePanel === "details"} aria-controls="seller-panel-details" className={activePanel === "details" ? "is-active" : ""} onClick={() => setActivePanel("details")}>{copy("sellerDetailsTab", "发布商品", "Publish")}</button>
        {!usesLegacyMarketplace ? <button type="button" role="tab" aria-selected={activePanel === "demand"} aria-controls="seller-panel-demand" className={activePanel === "demand" ? "is-active" : ""} onClick={() => setActivePanel("demand")}>{copy("sellerDemandTab", "需求匹配", "Demand")}</button> : null}
        <button type="button" role="tab" aria-selected={activePanel === "contacts"} aria-controls="seller-panel-contacts" className={activePanel === "contacts" ? "is-active" : ""} onClick={() => setActivePanel("contacts")}>{copy("sellerContactsTab", "联系申请", "Contacts")}<span>{introductions.length}</span></button>
      </nav>

      <div id="seller-panel-details" className="seller-settings-panel" role="tabpanel" hidden={activePanel !== "details"}>
        <section className="surface seller-upload" aria-labelledby="seller-upload-title">
        <SectionHeading title={copy("uploadTitle", "发布商品")} action="返回商品列表" onAction={() => setActivePanel("history")} />
        <p className="seller-upload-intro">填写买家真正需要看到的信息。提交后进入审核，通过后才会公开展示。</p>
        {agentDraft ? (
          <div className="seller-agent-draft" role="status">
            <div>
              <strong>{copy("agentDraftTitle", "对话草稿已准备好", "Conversation draft ready")}</strong>
              <p>{agentDraft.narrative}</p>
            </div>
            <button className="text-action" type="button" onClick={importAgentDraft} disabled={draftImported}>
              {draftImported ? copy("agentDraftImportedLabel", "已放入编辑器", "Added to editor") : copy("agentDraftImportLabel", "放入编辑器", "Add to editor")}
            </button>
          </div>
        ) : null}
          <div className="seller-media-uploader seller-upload-wide">
            <div className="seller-media-uploader-heading">
              <div>
                <strong>商品图片</strong>
                <small>上传清晰实拍图，至少一张；第一张作为商品封面。</small>
              </div>
              <label className="text-action seller-media-picker" htmlFor="seller-media-input">
                <FileUp size={16} aria-hidden="true" />
                {mediaUploading ? "上传中…" : "上传图片"}
                <input
                  id="seller-media-input"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    void uploadFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                  disabled={mediaUploading || submitting}
                />
              </label>
            </div>
            {attachments.length ? (
              <ul className="seller-media-list" aria-label={copy("mediaListLabel", "已添加的附件")}>
                {attachments.map((attachment) => (
                  <li key={attachment.attachment_ref}>
                    <span title={attachment.file_name}>{attachment.file_name}</span>
                    <small>{formatAttachmentSize(attachment.size_bytes)}</small>
                    <button
                      type="button"
                      aria-label={`${copy("removeMediaLabel", "移除附件")} ${attachment.file_name}`}
                      onClick={() => setAttachments((current) => current.filter((item) => item.attachment_ref !== attachment.attachment_ref))}
                      disabled={mediaUploading || submitting}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        <form className="seller-upload-form" onSubmit={submit}>
          <label htmlFor="seller-display-name">
            <span>商品名称</span>
            <input id="seller-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="写清品牌、型号或商品内容" maxLength={500} required />
          </label>
          <label htmlFor="seller-category"><span>商品分类</span><input id="seller-category" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="填写你的商品分类" maxLength={120} required /></label>
          <label className="seller-upload-wide" htmlFor="seller-product-description"><span>商品描述</span><textarea id="seller-product-description" value={productDescription} onChange={(event) => setProductDescription(event.target.value)} rows={4} maxLength={4000} placeholder="介绍商品特点、包含内容、使用条件和交付说明" required /></label>
          <label htmlFor="seller-asking-amount">
            <span>{copy("priceLabel", "价格")}{currency ? `（${currency}）` : ""}</span>
            <input id="seller-asking-amount" value={askingAmount} onChange={(event) => setAskingAmount(event.target.value)} inputMode="decimal" placeholder={amountPlaceholder(pricingScale, locale)} required />
          </label>
          <label htmlFor="seller-delivery-mode"><span>交付方式</span><select id="seller-delivery-mode" value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value as typeof deliveryMode)} required><option value="">选择交付方式</option><option value="digital">在线交付</option><option value="shipping">物流交付</option><option value="service">线下或人工交付</option></select></label>
          <label htmlFor="seller-stock"><span>可售库存</span><input id="seller-stock" value={stockQuantity} onChange={(event) => setStockQuantity(event.target.value)} type="number" min={0} max={1000000} step={1} required /><small>填 0 表示暂时售罄</small></label>
          <div className="seller-upload-actions seller-upload-wide">
            <p><FileUp size={17} aria-hidden="true" /> {copy("reviewNotice", "提交后状态为“待审核”，平台不会自动发布未经确认的资料。")}</p>
            <motion.button className="button button-dark" type="submit" disabled={submitting || (isLiveMarketplaceEnabled() && (!subplatform.domainId || (usesLegacyMarketplace && (!subplatform.assetSchemaId || !pricingCurrency || !Number.isInteger(pricingScale)))))} whileTap={{ scale: 0.97 }} transition={spring}>
              {submitting ? copy("submittingLabel", "正在提交…") : copy("submitForReviewLabel", "上传并提交审核")}
              {!submitting ? <ArrowRight size={18} aria-hidden="true" /> : null}
            </motion.button>
          </div>
        </form>
        </section>
      </div>

      <section id="seller-panel-history" className="surface seller-submissions seller-settings-panel" role="tabpanel" hidden={activePanel !== "history"} aria-labelledby="seller-submissions-title">
        <SectionHeading title={copy("submissionHistoryTitle", "商品列表")} action="发布商品" onAction={() => setActivePanel("details")} />
        {submissionsLoading ? (
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>{copy("loadingSubmissionsLabel", "正在读取你的提交记录…", "Loading your submissions…")}</p></div>
        ) : submissionsError ? (
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>{submissionsError}</p><button type="button" onClick={() => void loadSubmissions()}>{copy("reloadSubmissionsLabel", "重新读取", "Reload")}</button></div>
        ) : submissions.length ? (
          <ol className="submission-list">
            {submissions.map((submission) => (
              <li key={sellerRecordId(submission)}>
                <div><strong>{submission.display_name}</strong><small>{submission.external_key} · {sellerRecordPrice(submission, pricing, locale)} · {formatSubmissionDate(submission.updated_at, locale)}</small>{"review_reason" in submission && submission.review_reason ? <small className="submission-review-reason">{submission.review_reason}</small> : null}</div>
                <span className="submission-status">{submissionStatusLabel(submission.status, locale)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="seller-empty-state seller-product-empty"><FileUp size={24} aria-hidden="true" /><strong>还没有商品</strong><p>发布第一件商品，审核通过后买家就能在商城看到。</p><button className="button button-dark" type="button" onClick={() => setActivePanel("details")}>发布第一件商品</button></div>
        )}
      </section>

      {!usesLegacyMarketplace ? (
        <section id="seller-panel-demand" className="surface seller-submissions seller-demand-discovery seller-settings-panel" role="tabpanel" hidden={activePanel !== "demand"} aria-labelledby="seller-demand-title">
          <SectionHeading
            eyebrow={copy("demandDiscoveryEyebrow", "供需撮合")}
            title={copy("demandDiscoveryTitle", "找到已公开的需求")}
          />
          <p className="seller-discovery-intro">
            {copy("demandDiscoveryDescription", "只有主动允许供给方发现的需求会出现在这里。你可以先查看是否合适；需求方发起联系后，双方都同意才会交换联系方式。")}
          </p>
          {publishedOffers.length ? (
            <div className="seller-demand-offers">
              {publishedOffers.map((offer) => {
                const matches = demandMatches[offer.offer_id];
                const loading = demandMatchesLoading[offer.offer_id] === true;
                const error = demandMatchesError[offer.offer_id];
                return (
                  <article className="seller-demand-offer" key={offer.offer_id}>
                    <div className="seller-demand-offer-heading">
                      <div>
                        <strong>{offer.display_name}</strong>
                        <small>{offer.external_key} · {copy("publishedLabel", "已发布", "Published")}</small>
                      </div>
                      <button
                        className="text-action"
                        type="button"
                        onClick={() => void findDemandMatches(offer)}
                        disabled={loading}
                      >
                        {loading ? copy("findingDemandLabel", "寻找中…", "Finding demand…") : matches ? copy("refindDemandLabel", "重新寻找", "Search again") : copy("findDemandLabel", "寻找需求", "Find demand")}
                        <ArrowRight size={15} aria-hidden="true" />
                      </button>
                    </div>
                    {error ? <p className="seller-demand-error" role="alert">{error}</p> : null}
                    {matches ? (
                      matches.length ? (
                        <ol className="seller-demand-list">
                          {matches.map((demand) => {
                            return (
                              <li key={demand.intent_id}>
                                <div>
                                  <strong>{demand.narrative}</strong>
                                  <small>
                                    {demandMatchLevel(demand.score, locale)} · {copy("relevanceLabel", "相关", "relevant")}
                                    {demand.reasons.length ? ` · ${demand.reasons.slice(0, 2).join(locale === "en" ? ", " : "、")}` : ""}
                                  </small>
                                </div>
                                <span className="submission-status">{copy("waitingDemandContactLabel", "等待需求方联系", "Waiting for the buyer to make contact")}</span>
                              </li>
                            );
                          })}
                        </ol>
                      ) : (
                        <div className="seller-empty-state seller-demand-empty"><p>{copy("noDemandMatchesLabel", "暂时没有符合条件的公开需求。", "No matching published demand yet.")}</p></div>
                      )
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="seller-empty-state seller-demand-empty"><p>{copy("demandDiscoveryEmptyLabel", "供给审核通过并发布后，可以在这里寻找需求。", "Once an offer is approved and published, you can find demand here.")}</p></div>
          )}
        </section>
      ) : null}

      <div id="seller-panel-contacts" className="seller-settings-panel" role="tabpanel" hidden={activePanel !== "contacts"}>
        {activePanel === "contacts" ? <ContactProfileCard locale={locale} subplatform={subplatform} role="seller" onNotice={onNotice} /> : null}
        <section className="surface seller-submissions" aria-labelledby="seller-introductions-title">
          <SectionHeading eyebrow={copy("contactRequestsEyebrow", "联系申请")} title={copy("contactRequestsTitle", "需要你明确同意，才会交换联系方式")} />
        {introductionsError ? (
          <div className="seller-empty-state"><p>{introductionsError}</p></div>
        ) : introductions.length ? (
          <ol className="submission-list">
            {introductions.map((introduction) => (
              <li key={introduction.introduction_id}>
                <div>
                  <strong>{copy("contactRequestLabel", "一条撮合联系申请")}</strong>
                  <small>{introductionStatusLabel(introduction.status, locale)} · {formatSubmissionDate(introduction.created_at, locale)}</small>
                  {releasedContacts[introduction.introduction_id] ? (
                    <div className="buyer-contact-values">
                      {Object.entries(releasedContacts[introduction.introduction_id].counterpart.contact).map(([key, value]) => <span key={key}>{subplatformContactLabel(subplatform, key)}: {value}</span>)}
                    </div>
                  ) : null}
                </div>
                {releasedContacts[introduction.introduction_id] ? (
                  <span className="submission-status">{copy("contactVisibleLabel", "已可联系")}</span>
                ) : introduction.supply_contact_consent_at ? (
                  <button className="text-action" type="button" onClick={() => void releaseContact(introduction)} disabled={releasingContactId === introduction.introduction_id}>
                    {releasingContactId === introduction.introduction_id ? copy("contactReadingLabel", "读取中…") : copy("viewContactLabel", "查看对方联系方式")}
                  </button>
                ) : introduction.status === "contact_requested" ? (
                  <button className="text-action" type="button" onClick={() => void consent(introduction)} disabled={consentingIntroductionId === introduction.introduction_id}>
                    {consentingIntroductionId === introduction.introduction_id ? copy("processingLabel", "处理中…") : copy("consentContactLabel", "同意交换")}
                  </button>
                ) : (
                  <span className="submission-status">{copy("waitingBuyerConfirmationLabel", "等待需求方确认", "Waiting for the buyer to confirm")}</span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div className="seller-empty-state"><p>{copy("noContactRequestsLabel", "暂无待处理的联系申请。")}</p></div>
        )}
        </section>
      </div>
    </div>
  );
}

function amountPlaceholder(scale: number, locale: InterfaceLocale = "zh"): string {
  return locale === "en"
    ? (scale > 0 ? `e.g. 1000.${"0".repeat(Math.min(scale, 2))}` : "e.g. 1000")
    : (scale > 0 ? `例如 1000.${"0".repeat(Math.min(scale, 2))}` : "例如 1000");
}

function publicAttachment(attachment: MarketplaceAttachment): Record<string, unknown> {
  return {
    attachment_ref: attachment.attachment_ref,
    kind: attachment.kind,
    file_name: attachment.file_name,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
    ...(attachment.duration_ms === undefined ? {} : { duration_ms: attachment.duration_ms }),
    ...(attachment.metadata === undefined ? {} : { metadata: attachment.metadata }),
  };
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function demandMatchLevel(score: number, locale: InterfaceLocale): string {
  const bounded = Math.max(0, Math.min(1, score));
  if (locale === "en") {
    return bounded >= 0.8 ? "Strong fit" : bounded >= 0.6 ? "Good fit" : bounded >= 0.4 ? "Possible fit" : "Weak fit";
  }
  return bounded >= 0.8 ? "非常适合" : bounded >= 0.6 ? "比较适合" : bounded >= 0.4 ? "一般" : "不太适合";
}

function sellerRecordId(record: SellerRecord): string {
  return "submission_id" in record ? record.submission_id : record.offer_id;
}

function isMarketplaceOffer(record: SellerRecord): record is MarketplaceOffer {
  return "offer_id" in record;
}

function sellerRecordPrice(record: SellerRecord, pricing: { mode: string }, locale: InterfaceLocale = "zh"): string {
  if ("asking_amount" in record) {
    return formatMinorUnits(record.asking_amount, record.currency, record.currency_scale);
  }
  const amount = record.terms.amount_minor;
  const currency = record.terms.currency;
  const scale = record.terms.currency_scale;
  if (typeof amount === "string" && typeof currency === "string" && typeof scale === "number" && Number.isInteger(scale)) {
    return formatMinorUnits(amount, currency, scale);
  }
  const display = stringAttribute(record.terms, ["display_price", "price_label", "price"]);
  const min = record.terms.amount_min_minor;
  const max = record.terms.amount_max_minor;
  if (typeof min === "string" && typeof max === "string" && typeof currency === "string" && typeof scale === "number") {
    return `${formatMinorUnits(min, currency, scale)} – ${formatMinorUnits(max, currency, scale)}`;
  }
  if (typeof record.terms.pricing_note === "string" && record.terms.pricing_note.trim()) return record.terms.pricing_note.trim();
  return display || (pricing.mode === "none" ? "—" : locale === "en" ? "To be added" : "待补充");
}

function stringAttribute(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

function formatMinorUnits(amount: string, currency: string, scale: number): string {
  try {
    const value = BigInt(amount);
    const negative = value < 0n;
    const absolute = (negative ? -value : value).toString().padStart(scale + 1, "0");
    if (scale === 0) return `${currency} ${negative ? "-" : ""}${absolute}`;
    const splitAt = absolute.length - scale;
    return `${currency} ${negative ? "-" : ""}${absolute.slice(0, splitAt)}.${absolute.slice(splitAt)}`;
  } catch {
    return `${currency} ${amount}`;
  }
}

function formatSubmissionDate(value: string, locale: InterfaceLocale = "zh"): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? (locale === "en" ? "Unknown time" : "时间未知")
    : date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN");
}

function submissionStatusLabel(status: string, locale: InterfaceLocale = "zh"): string {
  if (locale === "en") {
    return {
      pending_review: "In review",
      approved: "Approved",
      rejected: "Needs changes",
      withdrawn: "Withdrawn",
    }[status] ?? status;
  }
  return {
    pending_review: "待审核",
    approved: "已通过",
    rejected: "需修改",
    withdrawn: "已撤回",
  }[status] ?? status;
}

function introductionStatusLabel(status: string, locale: InterfaceLocale = "zh"): string {
  if (locale === "en") {
    return {
      proposed: "Match created",
      contact_requested: "Waiting for your approval",
      contact_released: "Exchange approved",
      completed: "Completed",
      declined: "Declined",
      expired: "Expired",
      disputed: "Under review",
    }[status] ?? "Matching in progress";
  }
  return {
    proposed: "已建立撮合",
    contact_requested: "等待你的同意",
    contact_released: "已同意交换",
    completed: "已完成",
    declined: "已拒绝",
    expired: "已过期",
    disputed: "处理中",
  }[status] ?? "撮合处理中";
}

function toMinorUnits(value: string, scale: number): string | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > scale) return null;
  const result = `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(result) > 0n ? result : null;
}

function attributesFromForm(
  fieldValues: Record<string, string>,
  customFields: Array<{ key: string; value: string }>,
  schemaFields: Array<{ key: string; type?: string }>,
  advancedJson: string | null,
): Record<string, unknown> | null {
  if (advancedJson !== null) {
    try {
      const parsed = JSON.parse(advancedJson || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fieldValues)) {
    if (value.trim()) {
      const field = schemaFields.find((candidate) => candidate.key === key);
      attributes[key] = field?.type === "number" && Number.isFinite(Number(value)) ? Number(value) : value.trim();
    }
  }
  for (const field of customFields) {
    const key = field.key.trim();
    if (key && field.value.trim()) attributes[key] = field.value.trim();
  }
  return attributes;
}
