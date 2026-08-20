"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, FileUp, Plus, Trash2 } from "lucide-react";
import { motion } from "motion/react";

import {
  consentMarketplaceContact,
  createMarketplaceOffer,
  getMarketplaceIntroductions,
  getMarketplaceDemandMatches,
  getMarketplaceOffers,
  getSellerListingSubmissions,
  isLiveMarketplaceEnabled,
  retrieveMarketplaceContact,
  type MarketplaceIntroduction,
  type MarketplaceDemandCandidate,
  type MarketplaceContactResponse,
  type MarketplaceOffer,
  submitSellerListing,
  type ListingSubmission,
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
  uploadDescription: "Fields come from this platform's schema. The root stores structured JSON without guessing domain data.",
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
  const [askingAmount, setAskingAmount] = useState("");
  const [askingAmountMin, setAskingAmountMin] = useState("");
  const [askingAmountMax, setAskingAmountMax] = useState("");
  const [pricingNote, setPricingNote] = useState("");
  const pricing = pricingFor(subplatform);
  const copy = (key: string, fallbackZh: string, fallbackEn = sellerEnglishFallbacks[key] ?? fallbackZh) => localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);
  const isFixedPrice = pricing.mode === "fixed";
  const isRangePrice = pricing.mode === "range";
  const isNegotiablePrice = pricing.mode === "negotiable";
  const usesLegacyMarketplace = subplatform.marketplaceContract === "legacy-v1";
  const pricingCurrency = pricing.currency ?? subplatform.currency;
  const pricingScale = pricing.currencyScale ?? subplatform.currencyScale;
  const [currency, setCurrency] = useState(pricingCurrency ?? "");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<Array<{ id: string; key: string; value: string }>>([]);
  const [advancedAttributes, setAdvancedAttributes] = useState("{}");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draftImported, setDraftImported] = useState(false);
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
  const [activePanel, setActivePanel] = useState<SellerPanel>("details");

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
      setSubmissionsError(copy("platformIdentityIncomplete", "当前子平台还没有完成身份配置", "This platform has not finished its identity setup"));
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
    const draft = {
      conversation: {
        narrative: agentDraft.narrative,
        intent_id: agentDraft.intentId ?? null,
      },
      ...agentDraft.attributes,
      _terms: agentDraft.terms,
    };
    setAdvancedAttributes(JSON.stringify(draft, null, 2));
    setAdvancedOpen(true);
    setDraftImported(true);
    onNotice(copy("agentDraftImportedNotice", "已把对话草稿放入高级资料，请检查并补齐字段后提交", "The conversation draft is in advanced attributes; review it before submitting"));
  };

  const publishedOffers = useMemo(
    () => submissions.filter(isMarketplaceOffer).filter((offer) => offer.status === "active"),
    [submissions],
  );

  const schemaFields = useMemo(() => {
    const configured = subplatform.ui?.supplyFields ?? [];
    if (configured.length) return configured;
    const properties = subplatform.assetSchema?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
    const required = new Set(Array.isArray(subplatform.assetSchema?.required) ? subplatform.assetSchema.required.filter((key): key is string => typeof key === "string") : []);
    return Object.entries(properties).slice(0, 64).flatMap(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const descriptor = value as { title?: unknown; type?: unknown; format?: unknown; description?: unknown; enum?: unknown };
      const type = descriptor.enum && Array.isArray(descriptor.enum) ? "select" : descriptor.format === "uri" ? "url" : descriptor.type === "number" || descriptor.type === "integer" ? "number" : descriptor.format === "date" ? "date" : "text";
      return [{
        key,
        label: typeof descriptor.title === "string" && descriptor.title.trim() ? descriptor.title : key,
        type: type as "text" | "number" | "url" | "date" | "select",
        required: required.has(key),
        placeholder: typeof descriptor.description === "string" ? descriptor.description : undefined,
        options: Array.isArray(descriptor.enum) ? descriptor.enum.filter((item): item is string => typeof item === "string") : undefined,
      }];
    });
  }, [subplatform.assetSchema, subplatform.ui?.supplyFields]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = displayName.trim();
    const normalizedKey = externalKey.trim() || `offer-${crypto.randomUUID()}`;
    const normalizedCurrency = currency.trim().toUpperCase();
    const normalizedAmount = isFixedPrice ? toMinorUnits(askingAmount, pricingScale ?? 0) : null;
    const normalizedMin = isRangePrice ? toMinorUnits(askingAmountMin, pricingScale ?? 0) : null;
    const normalizedMax = isRangePrice ? toMinorUnits(askingAmountMax, pricingScale ?? 0) : null;
    if (!normalizedName || (isFixedPrice && (!normalizedAmount || !normalizedCurrency)) || (isRangePrice && (!normalizedMin || !normalizedMax || !normalizedCurrency))) {
      onNotice(isFixedPrice
        ? copy("fixedPriceRequired", "请完整填写名称、报价和结算币种", "Enter a name, price, and currency")
        : isRangePrice
          ? copy("rangePriceRequired", "请完整填写价格区间和结算币种", "Enter a price range and currency")
          : copy("offerNameRequired", "请填写供给名称", "Enter an offer name"));
      return;
    }
    if (isRangePrice && BigInt(normalizedMin as string) > BigInt(normalizedMax as string)) {
      onNotice(copy("rangePriceOrderError", "价格区间的最低值不能高于最高值", "The minimum price cannot exceed the maximum"));
      return;
    }
    if (!isLiveMarketplaceEnabled()) {
      onNotice(copy("supplyApiUnavailableNotice", "当前环境未启用真实供给 API，资料没有写入系统", "The live supply API is disabled; nothing was saved"));
      return;
    }
    if (!subplatform.domainId) {
      onNotice(copy("platformIdentityIncompleteNotice", "当前子平台尚未完成身份配置", "This platform has not finished its identity setup"));
      return;
    }
    if (usesLegacyMarketplace && (pricing.mode !== "fixed" || !subplatform.assetSchemaId || !pricingCurrency
      || typeof pricingScale !== "number"
      || !Number.isInteger(pricingScale)
      || pricingScale < 0 || pricingScale > 18)) {
      onNotice(copy("platformSchemaIncomplete", "当前子平台尚未配置完整的资料 schema、结算币种和价格精度", "This platform has incomplete schema, currency, or price precision settings"));
      return;
    }
    const missing = schemaFields.find((field) => field.required && !fieldValues[field.key]?.trim());
    if (missing) {
      onNotice(locale === "en" ? `Enter ${missing.label}` : `请填写${missing.label}`);
      return;
    }
    const parsedAttributes = attributesFromForm(fieldValues, customFields, schemaFields, advancedOpen ? advancedAttributes : null);
    if (!parsedAttributes) {
      onNotice(copy("advancedJsonError", "高级资料必须是有效的 JSON 对象", "Advanced attributes must be a valid JSON object"));
      return;
    }

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
      onNotice(error instanceof Error ? error.message : copy("platformSessionError", "当前子平台身份配置不完整", "This platform's identity configuration is incomplete"));
      return;
    }
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?role=seller&next=${encodeURIComponent(next)}`);
      return;
    }
    setSubmitting(true);
    try {
      const record: SellerRecord = usesLegacyMarketplace
        ? await submitSellerListing({
            session,
            domainId: subplatform.domainId,
            assetSchemaId: subplatform.assetSchemaId as string,
            externalKey: normalizedKey,
            displayName: normalizedName,
            attributes: parsedAttributes,
            askingAmount: normalizedAmount as string,
            currency: normalizedCurrency,
            currencyScale: pricingScale as number,
          })
        : await createMarketplaceOffer({
            session,
            domainId: subplatform.domainId,
            externalKey: normalizedKey,
            displayName: normalizedName,
            attributes: parsedAttributes,
            terms: {
              pricing_mode: pricing.mode,
              ...(normalizedAmount ? { amount_minor: normalizedAmount } : {}),
              ...(normalizedMin ? { amount_min_minor: normalizedMin } : {}),
              ...(normalizedMax ? { amount_max_minor: normalizedMax } : {}),
              ...(normalizedCurrency ? { currency: normalizedCurrency } : {}),
              ...(pricingScale !== undefined ? { currency_scale: pricingScale } : {}),
              ...(pricing.label ? { pricing_label: pricing.label } : {}),
              ...(pricingNote.trim() ? { pricing_note: pricingNote.trim() } : {}),
            },
          });
      setSubmissions((current) => [record, ...current]);
      setExternalKey("");
      setDisplayName("");
      setAskingAmount("");
      setAskingAmountMin("");
      setAskingAmountMax("");
      setPricingNote("");
      setCurrency(pricingCurrency ?? "");
      setFieldValues({});
      setCustomFields([]);
      setAdvancedAttributes("{}");
      setAdvancedOpen(false);
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
          <strong>{subplatform.label || copy("currentPlatformLabel", "当前子平台")}</strong>
          <span>{submissions.length ? `${copy("submittedPrefix", "已提交")} ${submissions.length} ${copy("submittedSuffix", "份资料")}` : copy("noSubmissionsLabel", "还没有提交资料")}</span>
        </div>
        <span className="seller-mode-note">{copy("identityProtectionLabel", "账号和联系方式由根平台保护")}</span>
      </div>

      <nav className="seller-settings-nav" role="tablist" aria-label={copy("sellerSettingsSectionsLabel", "供给设置分区", "Supply settings sections")}>
        <button type="button" role="tab" aria-selected={activePanel === "details"} aria-controls="seller-panel-details" className={activePanel === "details" ? "is-active" : ""} onClick={() => setActivePanel("details")}>{copy("sellerDetailsTab", "供给资料", "Offer details")}</button>
        <button type="button" role="tab" aria-selected={activePanel === "history"} aria-controls="seller-panel-history" className={activePanel === "history" ? "is-active" : ""} onClick={() => setActivePanel("history")}>{copy("sellerHistoryTab", "提交记录", "History")}<span>{submissions.length}</span></button>
        {!usesLegacyMarketplace ? <button type="button" role="tab" aria-selected={activePanel === "demand"} aria-controls="seller-panel-demand" className={activePanel === "demand" ? "is-active" : ""} onClick={() => setActivePanel("demand")}>{copy("sellerDemandTab", "需求匹配", "Demand")}</button> : null}
        <button type="button" role="tab" aria-selected={activePanel === "contacts"} aria-controls="seller-panel-contacts" className={activePanel === "contacts" ? "is-active" : ""} onClick={() => setActivePanel("contacts")}>{copy("sellerContactsTab", "联系申请", "Contacts")}<span>{introductions.length}</span></button>
      </nav>

      <div id="seller-panel-details" className="seller-settings-panel" role="tabpanel" hidden={activePanel !== "details"}>
        <section className="surface seller-upload" aria-labelledby="seller-upload-title">
        <SectionHeading eyebrow={copy("uploadEyebrow", "资料上传")} title={copy("uploadTitle", "提交一份新的供给资料")} />
        <p className="seller-upload-intro">
          {copy("uploadDescription", "字段由当前子平台的 schema 定义。根平台只保存结构化 JSON，不会替供给方猜测或填充领域信息。")}
        </p>
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
        <form className="seller-upload-form" onSubmit={submit}>
          <label htmlFor="seller-display-name">
            <span>{copy("offerNameLabel", "供给名称")}</span>
            <input id="seller-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={copy("offerNamePlaceholder", "由你填写")} maxLength={500} required />
          </label>
          <label htmlFor="seller-external-key">
            <span>{copy("externalKeyLabel", "内部编号")}</span>
            <input id="seller-external-key" value={externalKey} onChange={(event) => setExternalKey(event.target.value)} placeholder={copy("externalKeyPlaceholder", "留空则由平台生成")} maxLength={256} />
          </label>
          {isFixedPrice ? (
            <>
              <label htmlFor="seller-asking-amount">
                <span>{copy("priceLabel", "报价")}{currency ? `（${currency}）` : ""}</span>
                <input id="seller-asking-amount" value={askingAmount} onChange={(event) => setAskingAmount(event.target.value)} inputMode="decimal" placeholder={amountPlaceholder(pricingScale ?? 0, locale)} required />
              </label>
              <label htmlFor="seller-currency">
                <span>{copy("currencyLabel", "币种")}</span>
                <input id="seller-currency" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder={copy("currencyPlaceholder", "等待子平台配置")} maxLength={3} readOnly={Boolean(pricingCurrency)} required />
              </label>
            </>
          ) : null}
          {isRangePrice ? (
            <>
              <label htmlFor="seller-asking-amount-min">
                <span>{copy("priceMinLabel", "最低报价")}{currency ? `（${currency}）` : ""}</span>
                <input id="seller-asking-amount-min" value={askingAmountMin} onChange={(event) => setAskingAmountMin(event.target.value)} inputMode="decimal" placeholder={amountPlaceholder(pricingScale ?? 0, locale)} required />
              </label>
              <label htmlFor="seller-asking-amount-max">
                <span>{copy("priceMaxLabel", "最高报价")}{currency ? `（${currency}）` : ""}</span>
                <input id="seller-asking-amount-max" value={askingAmountMax} onChange={(event) => setAskingAmountMax(event.target.value)} inputMode="decimal" placeholder={amountPlaceholder(pricingScale ?? 0, locale)} required />
              </label>
              <label htmlFor="seller-currency-range">
                <span>{copy("currencyLabel", "币种")}</span>
                <input id="seller-currency-range" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder={copy("currencyPlaceholder", "等待子平台配置")} maxLength={3} readOnly={Boolean(pricingCurrency)} required />
              </label>
            </>
          ) : null}
          {isNegotiablePrice ? (
            <label className="seller-upload-wide" htmlFor="seller-pricing-note">
              <span>{copy("pricingNoteLabel", "议价条件")}</span>
              <textarea id="seller-pricing-note" value={pricingNote} onChange={(event) => setPricingNote(event.target.value)} rows={3} maxLength={500} placeholder={copy("pricingNotePlaceholder", "由你说明价格、条件或面议范围")} />
            </label>
          ) : null}
          {schemaFields.map((field) => (
            <label key={field.key} htmlFor={`seller-attribute-${field.key}`}>
              <span>{field.label}{field.required ? " *" : ""}</span>
              {field.type === "select" ? (
                <select id={`seller-attribute-${field.key}`} value={fieldValues[field.key] ?? ""} onChange={(event) => setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))}>
                  <option value="">{copy("selectFieldPlaceholder", "请选择", "Select")}</option>
                  {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input id={`seller-attribute-${field.key}`} type={field.type ?? "text"} value={fieldValues[field.key] ?? ""} onChange={(event) => setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} required={field.required} />
              )}
            </label>
          ))}
          {customFields.map((field) => (
            <div className="seller-custom-field" key={field.id}>
              <input aria-label={copy("customFieldNameLabel", "自定义字段名", "Custom field name")} value={field.key} onChange={(event) => setCustomFields((current) => current.map((item) => item.id === field.id ? { ...item, key: event.target.value } : item))} placeholder={copy("customFieldNamePlaceholder", "字段名", "Field name")} />
              <input aria-label={copy("customFieldValueLabel", "自定义字段值", "Custom field value")} value={field.value} onChange={(event) => setCustomFields((current) => current.map((item) => item.id === field.id ? { ...item, value: event.target.value } : item))} placeholder={copy("customFieldValuePlaceholder", "字段值", "Field value")} />
              <button type="button" aria-label={copy("removeCustomFieldLabel", "删除自定义字段", "Remove custom field")} onClick={() => setCustomFields((current) => current.filter((item) => item.id !== field.id))}><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          ))}
          <div className="seller-upload-wide seller-form-tools">
            <button className="text-action" type="button" onClick={() => setCustomFields((current) => [...current, { id: crypto.randomUUID(), key: "", value: "" }])}><Plus size={16} aria-hidden="true" /> {copy("addCustomFieldLabel", "添加字段", "Add field")}</button>
            <button className="text-action" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? copy("collapseAdvancedLabel", "收起高级资料", "Hide advanced attributes") : copy("advancedJsonToggleLabel", "使用高级 JSON", "Use advanced JSON")}</button>
          </div>
          {advancedOpen ? (
            <label className="seller-upload-wide" htmlFor="seller-attributes">
                <span>{copy("advancedAttributesLabel", "高级资料（JSON）")}</span>
              <textarea id="seller-attributes" value={advancedAttributes} onChange={(event) => setAdvancedAttributes(event.target.value)} rows={8} spellCheck={false} />
            </label>
          ) : null}
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
        <SectionHeading eyebrow={copy("submissionHistoryEyebrow", "提交记录")} title={copy("submissionHistoryTitle", "当前子平台的资料")} />
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
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>{copy("noSubmissionHistoryLabel", "还没有上传记录。第一份资料由你定义。")}</p></div>
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
        <ContactProfileCard locale={locale} subplatform={subplatform} role="seller" onNotice={onNotice} />
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
