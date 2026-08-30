"use client";

import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowRight, FileUp, Pencil, Trash2 } from "lucide-react";
import { motion } from "motion/react";

import {
  consentMarketplaceContact,
  createMarketplaceOffer,
  getMarketplaceIntroductions,
  getMarketplaceDemandMatches,
  getMarketplaceOffers,
  getSellerListingSubmissions,
  getStoreProductTemplates,
  isLiveMarketplaceEnabled,
  uploadMarketplaceAttachment,
  retrieveMarketplaceContact,
  type MarketplaceIntroduction,
  type MarketplaceDemandCandidate,
  type MarketplaceContactResponse,
  type MarketplaceOffer,
  type StoreProductTemplateCatalog,
  type StoreSummary,
  submitSellerListing,
  updateMarketplaceOffer,
  withdrawMarketplaceOffer,
  type ListingSubmission,
  type MarketplaceAttachment,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import { localizedSubplatformCopy } from "../lib/localized-copy";
import type { ProductTemplateConfig } from "../product-templates";
import {
  pricingFor,
  subplatformContactLabel,
  type SubplatformConfig,
} from "../subplatform";
import {
  serializeSupplyFieldValues,
  supplyFieldValuesFromAttributes,
  withoutSupplyFieldAttributes,
} from "../supply-fields";
import { ProductTemplateSelector } from "./ProductTemplateSelector";
import { SectionHeading, spring } from "./Primitives";
import { StoreProductTemplateSettings } from "./StoreProductTemplateSettings";
import { SupplyFieldEditor } from "./SupplyFieldEditor";

interface SellerDashboardProps {
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
  store?: StoreSummary;
  canManageStore?: boolean;
  focusOfferId?: string | null;
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
  supplyTitle:
    "Upload real information and let the platform find the right demand.",
  supplyDescription:
    "The root platform does not seed sample content. Submissions enter review before matching.",
  identityProtectionLabel:
    "Your account and contact details stay protected by the root platform",
  supplyStatusLabel: "Supply status",
  submittedPrefix: "Submitted",
  submittedSuffix: "items",
  noSubmissionsLabel: "No items submitted yet",
  submissionWorkflowLabel: "Submissions enter this platform's review workflow",
  uploadEyebrow: "Upload",
  uploadTitle: "Submit a new offer",
  uploadDescription:
    "Add a product image, name, description, and price. The mall reviews it before it appears in search.",
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
  reviewNotice: "The mall reviews every submission before buyers can see it.",
  submittingLabel: "Submitting…",
  submitForReviewLabel: "Submit for review",
  submissionHistoryEyebrow: "Submission history",
  submissionHistoryTitle: "Your offers on this platform",
  noSubmissionHistoryLabel: "No uploads yet. Define your first offer.",
  demandDiscoveryEyebrow: "Find buyers",
  demandDiscoveryTitle: "See what buyers are looking for",
  demandDiscoveryDescription:
    "Only people who opted in to discovery appear here. Contact details are exchanged only after both sides agree.",
  contactRequestsEyebrow: "Contact requests",
  contactRequestsTitle:
    "Both sides must agree before contact details are exchanged",
  contactRequestLabel: "A buyer wants to contact you",
  contactVisibleLabel: "Ready to contact",
  contactReadingLabel: "Loading…",
  viewContactLabel: "View contact details",
  processingLabel: "Processing…",
  consentContactLabel: "Agree to exchange",
  noContactRequestsLabel: "No pending contact requests.",
  contactLoginNotice: "Sign in to view contact details after both sides agree",
  contactReleasedNotice:
    "Contact details are unlocked; use the channel provided",
  contactReleaseError: "Contact details are temporarily unavailable",
};

/** Generic seller surface. The active subplatform owns the meaning of `attributes`. */
export function SellerDashboard({
  locale,
  onNotice,
  subplatform,
  store,
  canManageStore = false,
  focusOfferId,
  agentDraft = null,
}: SellerDashboardProps) {
  const [externalKey, setExternalKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [category, setCategory] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<
    "" | "digital" | "shipping" | "service"
  >("");
  const [stockQuantity, setStockQuantity] = useState("1");
  const [productDescription, setProductDescription] = useState("");
  const [askingAmount, setAskingAmount] = useState("");
  const [supplyFieldValues, setSupplyFieldValues] = useState<
    Record<string, string>
  >({});
  const [productTemplateCatalog, setProductTemplateCatalog] =
    useState<StoreProductTemplateCatalog | null>(null);
  const [productTemplatesLoading, setProductTemplatesLoading] = useState(
    Boolean(store),
  );
  const [productTemplatesError, setProductTemplatesError] = useState<
    string | null
  >(null);
  const [selectedProductTemplateId, setSelectedProductTemplateId] = useState<
    string | null
  >(null);
  const [draftProductTemplate, setDraftProductTemplate] =
    useState<ProductTemplateConfig | null>(null);
  const [editingSourceProductTemplate, setEditingSourceProductTemplate] =
    useState<ProductTemplateConfig | null>(null);
  const [productTemplateModeStoreId, setProductTemplateModeStoreId] = useState<
    string | null
  >(null);
  const productTemplateLoadRef = useRef(0);
  const productTemplateDefaultInitializedStoreRef = useRef<string | null>(null);
  const storeId = store?.id;
  const activeProductTemplateCatalog =
    productTemplateCatalog?.storeId === storeId
      ? productTemplateCatalog
      : null;
  const pricing = pricingFor(subplatform);
  const legacySupplyFields = subplatform.ui?.supplyFields ?? [];
  const usesProductTemplates = Boolean(
    activeProductTemplateCatalog?.templates.length ||
      productTemplateModeStoreId === storeId ||
      draftProductTemplate ||
      selectedProductTemplateId,
  );
  const enabledProductTemplates = useMemo(
    () =>
      activeProductTemplateCatalog?.templates.filter((template) =>
        activeProductTemplateCatalog.enabledTemplateIds.includes(template.id),
      ) ?? [],
    [activeProductTemplateCatalog],
  );
  const catalogSelectedProductTemplate =
    activeProductTemplateCatalog?.templates.find(
      (template) => template.id === selectedProductTemplateId,
    );
  const selectedProductTemplate =
    draftProductTemplate?.id === selectedProductTemplateId
      ? draftProductTemplate
      : catalogSelectedProductTemplate;
  const selectedProductTemplateIsEnabled = Boolean(
    selectedProductTemplateId &&
      activeProductTemplateCatalog?.enabledTemplateIds.includes(
        selectedProductTemplateId,
      ) &&
      catalogSelectedProductTemplate,
  );
  const supplyFields = usesProductTemplates
    ? (selectedProductTemplate?.supplyFields ?? [])
    : legacySupplyFields;
  const copy = (
    key: string,
    fallbackZh: string,
    fallbackEn = sellerEnglishFallbacks[key] ?? fallbackZh,
  ) =>
    localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);
  const usesLegacyMarketplace = subplatform.marketplaceContract === "legacy-v1";
  const pricingCurrency = pricing.currency ?? subplatform.currency ?? "CNY";
  const pricingScale = pricing.currencyScale ?? subplatform.currencyScale ?? 2;
  const [currency, setCurrency] = useState(pricingCurrency ?? "");
  const [draftImported, setDraftImported] = useState(false);
  const [attachments, setAttachments] = useState<MarketplaceAttachment[]>([]);
  const [mediaUploading, setMediaUploading] = useState(false);
  const mediaUploadingRef = useRef(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<SellerRecord[]>([]);
  const submissionRowRefs = useRef(new Map<string, HTMLLIElement>());
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [editingOffer, setEditingOffer] = useState<MarketplaceOffer | null>(
    null,
  );
  const [withdrawConfirmId, setWithdrawConfirmId] = useState<string | null>(
    null,
  );
  const [withdrawingOfferIds, setWithdrawingOfferIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [introductions, setIntroductions] = useState<MarketplaceIntroduction[]>(
    [],
  );
  const [introductionsError, setIntroductionsError] = useState<string | null>(
    null,
  );
  const [demandMatches, setDemandMatches] = useState<
    Record<string, MarketplaceDemandCandidate[]>
  >({});
  const [demandMatchesLoading, setDemandMatchesLoading] = useState<
    Record<string, boolean>
  >({});
  const [demandMatchesError, setDemandMatchesError] = useState<
    Record<string, string>
  >({});
  const [consentingIntroductionId, setConsentingIntroductionId] = useState<
    string | null
  >(null);
  const [releasedContacts, setReleasedContacts] = useState<
    Record<string, MarketplaceContactResponse>
  >({});
  const [releasingContactId, setReleasingContactId] = useState<string | null>(
    null,
  );
  const [activePanel, setActivePanel] = useState<SellerPanel>("history");

  const loadProductTemplates = useCallback(async () => {
    const loadId = ++productTemplateLoadRef.current;
    setProductTemplatesError(null);
    setProductTemplatesLoading(Boolean(storeId));
    if (!storeId) return;
    try {
      const catalog = await getStoreProductTemplates(storeId);
      if (productTemplateLoadRef.current !== loadId) return;
      setProductTemplateCatalog(catalog);
    } catch (error) {
      if (productTemplateLoadRef.current !== loadId) return;
      setProductTemplatesError(
        error instanceof Error ? error.message : "商品模板设置读取失败",
      );
    } finally {
      if (productTemplateLoadRef.current === loadId)
        setProductTemplatesLoading(false);
    }
  }, [storeId]);

  const loadSubmissions = useCallback(async () => {
    setSubmissions([]);
    setIntroductions([]);
    setSubmissionsError(null);
    setIntroductionsError(null);
    setDemandMatches({});
    setDemandMatchesLoading({});
    setDemandMatchesError({});
    if (!isLiveMarketplaceEnabled()) {
      setSubmissionsError(
        copy(
          "supplyApiUnavailable",
          "当前环境暂时无法发布商品，请联系商城工作人员",
          "The live supply API is not enabled for this deployment",
        ),
      );
      return;
    }
    if (!subplatform.domainId || !subplatform.tenantId) {
      setSubmissionsError(
        copy(
          "platformIdentityIncomplete",
          "店铺信息还没配置好，请联系商城工作人员",
          "This store has not finished its identity setup",
        ),
      );
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
        setSubmissionsError(
          copy(
            "signInToViewSubmissions",
            "请先登录，再查看你的商品",
            "Sign in to view your submissions",
          ),
        );
        return;
      }
      if (usesLegacyMarketplace) {
        setSubmissions(
          await getSellerListingSubmissions({
            session,
            domainId: subplatform.domainId,
          }),
        );
      } else {
        const offers = await getMarketplaceOffers({
          session,
          domainId: subplatform.domainId,
          domainWide: session.role === "both",
        });
        setSubmissions(
          offers.filter(
            (offer) =>
              offer.status !== "withdrawn" && offer.status !== "closed",
          ),
        );
      }
      setIntroductions(
        await getMarketplaceIntroductions({
          session,
          domainId: subplatform.domainId,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : copy(
              "submissionLoadError",
              "商品列表加载失败，请稍后再试",
              "Could not load submissions",
            );
      setSubmissionsError(message);
      setIntroductionsError(message);
    } finally {
      setSubmissionsLoading(false);
    }
  }, [
    subplatform.domainId,
    subplatform.marketplaceContract,
    subplatform.path,
    subplatform.slug,
    subplatform.tenantId,
    usesLegacyMarketplace,
  ]);

  const findDemandMatches = async (record: MarketplaceOffer) => {
    if (!subplatform.domainId || !subplatform.tenantId) return;
    setDemandMatchesLoading((current) => ({
      ...current,
      [record.offer_id]: true,
    }));
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
        onNotice(
          copy(
            "signInToFindDemand",
            "请先登录，再寻找买家",
            "Sign in to find published demand",
          ),
        );
        return;
      }
      const matches = await getMarketplaceDemandMatches({
        session,
        domainId: subplatform.domainId,
        offerId: record.offer_id,
        limit: 12,
      });
      setDemandMatches((current) => ({
        ...current,
        [record.offer_id]: matches,
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : copy(
              "demandMatchLoadError",
              "暂时找不到买家信息，请稍后再试",
              "Demand matching is temporarily unavailable",
            );
      setDemandMatchesError((current) => ({
        ...current,
        [record.offer_id]: message,
      }));
    } finally {
      setDemandMatchesLoading((current) => ({
        ...current,
        [record.offer_id]: false,
      }));
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
        onNotice(
          copy(
            "signInToProcessContact",
            "请先登录，再处理买家的联系申请",
            "Sign in to process contact requests",
          ),
        );
        return;
      }
      const updated = await consentMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
      });
      setIntroductions((current) =>
        current.map((item) =>
          item.introduction_id === updated.introduction_id ? updated : item,
        ),
      );
      window.dispatchEvent(new Event("matchplane:notifications-updated"));
      onNotice(
        copy(
          "contactConsentSaved",
          "已同意交换联系方式，买家现在可以看到你的联系方式",
          "Contact exchange approved; the buyer can view your channels",
        ),
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : copy(
              "contactConsentError",
              "联系申请处理失败，请稍后再试",
              "Could not process the contact request",
            ),
      );
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
        onNotice(copy("contactLoginNotice", "请先登录，再查看对方的联系方式"));
        return;
      }
      const contact = await retrieveMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
      });
      setReleasedContacts((current) => ({
        ...current,
        [introduction.introduction_id]: contact,
      }));
      window.dispatchEvent(new Event("matchplane:notifications-updated"));
      onNotice(
        copy(
          "contactReleasedNotice",
          "已拿到对方的联系方式，可以直接联系对方了",
        ),
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : copy("contactReleaseError", "联系方式暂时看不了，请稍后再试"),
      );
    } finally {
      setReleasingContactId(null);
    }
  };

  useEffect(() => {
    void loadProductTemplates();
    return () => {
      productTemplateLoadRef.current += 1;
    };
  }, [loadProductTemplates]);

  useEffect(() => {
    setProductTemplateCatalog((current) =>
      current?.storeId === storeId ? current : null,
    );
    productTemplateDefaultInitializedStoreRef.current = null;
    setEditingOffer(null);
    setSelectedProductTemplateId(null);
    setDraftProductTemplate(null);
    setEditingSourceProductTemplate(null);
    setProductTemplateModeStoreId(null);
    setExternalKey("");
    setDisplayName("");
    setCategory("");
    setDeliveryMode("");
    setStockQuantity("1");
    setProductDescription("");
    setAskingAmount("");
    setSupplyFieldValues({});
    setDraftImported(false);
    setAttachments([]);
  }, [storeId]);

  useEffect(() => {
    if (!storeId || !activeProductTemplateCatalog) return;
    if (activeProductTemplateCatalog.templates.length) {
      setProductTemplateModeStoreId(storeId);
    }
    if (productTemplateDefaultInitializedStoreRef.current === storeId) return;
    productTemplateDefaultInitializedStoreRef.current = storeId;
    if (editingOffer || selectedProductTemplateId !== null) return;
    const nextTemplate = activeProductTemplateCatalog.templates.find(
      (template) =>
        template.id === activeProductTemplateCatalog.defaultTemplateId &&
        activeProductTemplateCatalog.enabledTemplateIds.includes(template.id),
    );
    if (!nextTemplate) return;
    setSelectedProductTemplateId(nextTemplate.id);
    setDraftProductTemplate(nextTemplate);
    setCategory((current) => current || nextTemplate.category || "");
    setSupplyFieldValues((current) => ({
      ...supplyFieldValuesFromAttributes(
        nextTemplate.supplyFields,
        draftImported ? agentDraft?.attributes : undefined,
      ),
      ...current,
    }));
  }, [
    activeProductTemplateCatalog,
    agentDraft,
    draftImported,
    editingOffer,
    selectedProductTemplateId,
    storeId,
  ]);

  useEffect(() => {
    if (
      !selectedProductTemplateId ||
      draftProductTemplate?.id === selectedProductTemplateId ||
      !catalogSelectedProductTemplate
    ) {
      return;
    }
    setDraftProductTemplate(catalogSelectedProductTemplate);
    setSupplyFieldValues((current) => ({
      ...supplyFieldValuesFromAttributes(
        catalogSelectedProductTemplate.supplyFields,
        editingOffer?.attributes,
      ),
      ...current,
    }));
    if (
      editingOffer?.productTemplateId === selectedProductTemplateId &&
      !editingSourceProductTemplate
    ) {
      setEditingSourceProductTemplate(catalogSelectedProductTemplate);
    }
  }, [
    catalogSelectedProductTemplate,
    draftProductTemplate,
    editingOffer,
    editingSourceProductTemplate,
    selectedProductTemplateId,
  ]);

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  useEffect(() => {
    if (
      submissionsLoading ||
      !focusOfferId ||
      !submissions.some(
        (submission) => sellerRecordId(submission) === focusOfferId,
      )
    ) {
      return;
    }
    setActivePanel("history");
    const frame = window.requestAnimationFrame(() => {
      submissionRowRefs.current.get(focusOfferId)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusOfferId, submissions, submissionsLoading]);

  useEffect(() => {
    setCurrency(pricingCurrency ?? "");
  }, [pricingCurrency]);

  useEffect(() => {
    setDraftImported(false);
  }, [agentDraft?.intentId, agentDraft?.narrative]);

  useEffect(() => {
    if (usesLegacyMarketplace && activePanel === "demand")
      setActivePanel("details");
  }, [activePanel, usesLegacyMarketplace]);

  const importAgentDraft = () => {
    if (!agentDraft) return;
    setProductDescription(agentDraft.narrative);
    setSupplyFieldValues(
      supplyFieldValuesFromAttributes(supplyFields, agentDraft.attributes),
    );
    setAttachments(agentDraft.attachments?.slice(0, 8) ?? []);
    setDraftImported(true);
    onNotice(
      copy(
        "agentDraftImportedNotice",
        "已把对话草稿放入商品描述，请检查后提交",
        "The conversation draft was added to the product description",
      ),
    );
  };

  const resetOfferForm = () => {
    const defaultTemplate = activeProductTemplateCatalog?.templates.find(
      (template) =>
        template.id === activeProductTemplateCatalog.defaultTemplateId &&
        activeProductTemplateCatalog.enabledTemplateIds.includes(template.id),
    );
    const resetFields = activeProductTemplateCatalog?.templates.length
      ? (defaultTemplate?.supplyFields ?? [])
      : legacySupplyFields;
    setEditingOffer(null);
    setEditingSourceProductTemplate(null);
    setSelectedProductTemplateId(defaultTemplate?.id ?? null);
    setDraftProductTemplate(defaultTemplate ?? null);
    setExternalKey("");
    setDisplayName("");
    setCategory(defaultTemplate?.category ?? "");
    setDeliveryMode("");
    setStockQuantity("1");
    setProductDescription("");
    setAskingAmount("");
    setCurrency(pricingCurrency ?? "");
    setSupplyFieldValues(supplyFieldValuesFromAttributes(resetFields, {}));
    setDraftImported(false);
    setAttachments([]);
  };

  const beginOfferEdit = (offer: MarketplaceOffer) => {
    const nextDeliveryMode = stringAttribute(offer.attributes, [
      "delivery_mode",
    ]);
    const offerTemplate = activeProductTemplateCatalog?.templates.find(
      (template) => template.id === offer.productTemplateId,
    );
    const offerSupplyFields = activeProductTemplateCatalog?.templates.length
      ? (offerTemplate?.supplyFields ?? [])
      : legacySupplyFields;
    const nextScale = Number.isInteger(offer.terms.currency_scale)
      ? Number(offer.terms.currency_scale)
      : pricingScale;
    setEditingOffer(offer);
    setEditingSourceProductTemplate(offerTemplate ?? null);
    setSelectedProductTemplateId(offer.productTemplateId ?? null);
    setDraftProductTemplate(offerTemplate ?? null);
    setExternalKey(offer.external_key);
    setDisplayName(offer.display_name);
    setCategory(stringAttribute(offer.attributes, ["category"]) ?? "");
    setDeliveryMode(
      nextDeliveryMode === "digital" ||
        nextDeliveryMode === "shipping" ||
        nextDeliveryMode === "service"
        ? nextDeliveryMode
        : "",
    );
    const nextStock = offer.attributes.stock_quantity;
    setStockQuantity(
      typeof nextStock === "number" && Number.isSafeInteger(nextStock)
        ? String(nextStock)
        : "1",
    );
    setProductDescription(
      stringAttribute(offer.attributes, ["description"]) ?? "",
    );
    setSupplyFieldValues(
      activeProductTemplateCatalog?.templates.length && !offerTemplate
        ? unresolvedProductTemplateFieldValues(offer.attributes)
        : supplyFieldValuesFromAttributes(offerSupplyFields, offer.attributes),
    );
    setAskingAmount(
      typeof offer.terms.amount_minor === "string"
        ? fromMinorUnits(offer.terms.amount_minor, nextScale)
        : "",
    );
    setCurrency(
      typeof offer.terms.currency === "string"
        ? offer.terms.currency
        : (pricingCurrency ?? ""),
    );
    setAttachments(marketplaceOfferAttachments(offer.attributes));
    setWithdrawConfirmId(null);
    setActivePanel("details");
  };

  const cancelOfferEdit = () => {
    resetOfferForm();
    setActivePanel("history");
  };

  const withdrawOffer = async (offer: MarketplaceOffer) => {
    if (withdrawingOfferIds.has(offer.offer_id)) return;
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
      onNotice(
        error instanceof Error
          ? error.message
          : copy(
              "platformSessionError",
              "店铺信息不完整，请联系商城工作人员",
              "This store's identity configuration is incomplete",
            ),
      );
      return;
    }
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
      return;
    }

    setWithdrawingOfferIds((current) => {
      const next = new Set(current);
      next.add(offer.offer_id);
      return next;
    });
    try {
      const withdrawn = await withdrawMarketplaceOffer({
        session,
        domainId: subplatform.domainId as string,
        offerId: offer.offer_id,
        expectedVersion: offer.version,
      });
      setSubmissions((current) =>
        current.filter(
          (record) =>
            !isMarketplaceOffer(record) ||
            record.offer_id !== withdrawn.offer_id,
        ),
      );
      if (editingOffer?.offer_id === withdrawn.offer_id) resetOfferForm();
      setWithdrawConfirmId(null);
      onNotice(
        copy(
          "offerWithdrawnNotice",
          offer.status === "draft"
            ? "商品草稿已删除"
            : "商品已下架，买家不会再看到它",
          offer.status === "draft"
            ? "Draft deleted"
            : "Offer removed from the public catalog",
        ),
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : copy(
              "offerWithdrawError",
              "商品下架失败，请刷新页面后再试",
              "Could not withdraw the offer; reload and try again",
            ),
      );
    } finally {
      setWithdrawingOfferIds((current) => {
        const next = new Set(current);
        next.delete(offer.offer_id);
        return next;
      });
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || !files.length || mediaUploadingRef.current) return;
    if (!subplatform.tenantId || !subplatform.domainId) {
      onNotice(
        copy(
          "platformIdentityIncompleteNotice",
          "店铺信息还没配置好，请联系商城工作人员",
          "This store's identity configuration is incomplete",
        ),
      );
      return;
    }
    const selectedFiles = Array.from(files);
    const remaining = Math.max(0, 8 - attachments.length);
    if (!remaining) {
      onNotice(
        copy(
          "mediaLimitNotice",
          "最多上传 8 张图片",
          "You can add up to 8 images",
        ),
      );
      return;
    }
    const filesToUpload = selectedFiles.slice(0, remaining);
    const failedFiles: string[] = [];
    let successfulUploads = 0;
    mediaUploadingRef.current = true;
    setMediaUploading(true);
    try {
      for (const file of filesToUpload) {
        try {
          const uploaded = await uploadMarketplaceAttachment({
            platformPath: subplatform.path,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            file,
          });
          successfulUploads += 1;
          setAttachments((current) => [...current, uploaded].slice(0, 8));
        } catch {
          failedFiles.push(file.name);
        }
      }
      if (selectedFiles.length > remaining)
        onNotice(
          copy(
            "mediaLimitNotice",
            "最多上传 8 张图片，超出部分没有上传",
            "You can add up to 8 images; extra files were not uploaded",
          ),
        );
      if (failedFiles.length) {
        onNotice(
          `${copy(
            "mediaUploadPartialError",
            `${failedFiles.length} 张图片上传失败，已保留 ${successfulUploads} 张成功图片`,
            `${failedFiles.length} image(s) failed; ${successfulUploads} successful image(s) were kept`,
          )}：${failedFiles.join(locale === "en" ? ", " : "、")}。${copy(
            "mediaUploadRetryHint",
            "请检查失败图片后重新选择上传",
            "Check the failed images and select them again to retry",
          )}`,
        );
      }
    } finally {
      mediaUploadingRef.current = false;
      setMediaUploading(false);
    }
  };

  const publishedOffers = useMemo(
    () =>
      submissions
        .filter(isMarketplaceOffer)
        .filter((offer) => offer.status === "active"),
    [submissions],
  );
  const productTemplateInvalidReason = (() => {
    if (!store || !usesProductTemplates) return null;
    if (!activeProductTemplateCatalog)
      return locale === "en"
        ? "The product-template policy is unresolved. Refresh it before continuing."
        : "商品模板设置尚未解析完成，请刷新后再继续。";
    if (!enabledProductTemplates.length)
      return locale === "en"
        ? "No product template is enabled. A store manager must enable one before new products can be published."
        : "本店未启用任何商品模板，店主启用模板前不能发布新商品。";
    if (!selectedProductTemplateId)
      return editingOffer
        ? locale === "en"
          ? "This legacy offer is not bound to a product template. Choose an enabled replacement explicitly."
          : "该旧版商品未绑定商品模板，请显式选择一个当前启用的模板。"
        : locale === "en"
          ? "No default product template is available. Choose an enabled template explicitly."
          : "当前没有可用的默认商品模板，请显式选择一个当前启用的模板。";
    if (
      !activeProductTemplateCatalog.templates.some(
        (template) => template.id === selectedProductTemplateId,
      )
    )
      return locale === "en"
        ? "This offer references an unknown product template. Choose an enabled replacement explicitly."
        : "该商品绑定了当前目录中不存在的模板，请显式选择一个当前启用的模板。";
    if (!selectedProductTemplateIsEnabled)
      return locale === "en"
        ? "This offer's product template is disabled for the store. Choose an enabled replacement explicitly."
        : "该商品绑定的模板已被本店停用，请显式选择一个当前启用的模板。";
    return null;
  })();
  const productTemplateSubmitBlocked = Boolean(
    store &&
      (productTemplatesLoading ||
        productTemplatesError ||
        productTemplateInvalidReason),
  );

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (productTemplateSubmitBlocked) {
      onNotice(
        productTemplatesError ||
          productTemplateInvalidReason ||
          (locale === "en"
            ? "Wait for product templates to finish loading."
            : "请等待商品模板加载完成。"),
      );
      return;
    }
    const serializedSupplyFields = serializeSupplyFieldValues(
      supplyFields,
      supplyFieldValues,
    );
    if (serializedSupplyFields.error) {
      const invalidField = supplyFields.find(
        (field) => field.key === serializedSupplyFields.error?.key,
      );
      let recovery: string;
      switch (serializedSupplyFields.error.reason) {
        case "required":
          recovery = copy(
            "supplyFieldRequiredRecovery",
            "请填写这个必填字段后再提交",
            "Complete this required field before submitting",
          );
          break;
        case "number":
          recovery = copy(
            "supplyFieldNumberRecovery",
            "请输入有效数字后再提交",
            "Enter a valid number before submitting",
          );
          break;
        case "min":
          recovery = copy(
            "supplyFieldMinRecovery",
            invalidField?.min === undefined
              ? "请输入不低于最小值的数字"
              : `请输入不小于 ${invalidField.min} 的数字`,
            invalidField?.min === undefined
              ? "Enter a number at or above the minimum"
              : `Enter a number of at least ${invalidField.min}`,
          );
          break;
        case "max":
          recovery = copy(
            "supplyFieldMaxRecovery",
            invalidField?.max === undefined
              ? "请输入不高于最大值的数字"
              : `请输入不大于 ${invalidField.max} 的数字`,
            invalidField?.max === undefined
              ? "Enter a number at or below the maximum"
              : `Enter a number no greater than ${invalidField.max}`,
          );
          break;
        case "step":
          recovery = copy(
            "supplyFieldStepRecovery",
            invalidField?.step === undefined
              ? "请输入符合步进要求的数字"
              : `请按 ${invalidField.step} 的步进填写数字`,
            invalidField?.step === undefined
              ? "Enter a number that matches the required increment"
              : `Use increments of ${invalidField.step}`,
          );
          break;
        case "option":
          recovery = copy(
            "supplyFieldOptionRecovery",
            "请从提供的选项中重新选择",
            "Choose one of the available options",
          );
          break;
        case "url":
          recovery = copy(
            "supplyFieldUrlRecovery",
            "请输入以 http:// 或 https:// 开头的完整网址",
            "Enter a complete URL beginning with http:// or https://",
          );
          break;
        case "date":
          recovery = copy(
            "supplyFieldDateRecovery",
            "请输入有效日期",
            "Enter a valid date",
          );
          break;
      }
      onNotice(`${serializedSupplyFields.error.label}：${recovery}`);
      return;
    }
    const normalizedName = displayName.trim();
    const normalizedCategory = category.trim();
    const normalizedKey = externalKey.trim() || `offer-${crypto.randomUUID()}`;
    const normalizedCurrency = currency.trim().toUpperCase();
    const normalizedAmount = toMinorUnits(askingAmount, pricingScale);
    const normalizedStock = Number.parseInt(stockQuantity, 10);
    if (!isLiveMarketplaceEnabled()) {
      onNotice(
        copy(
          "supplyApiUnavailableNotice",
          "当前环境暂时无法发布商品，内容没有保存",
          "The live supply API is disabled; nothing was saved",
        ),
      );
      return;
    }
    if (
      !normalizedName ||
      !normalizedCategory ||
      !deliveryMode ||
      !productDescription.trim() ||
      !askingAmount.trim() ||
      !attachments.length
    ) {
      onNotice(
        copy(
          "productRequired",
          "请填写商品名称、分类、描述、价格、交付方式并上传商品图片",
          "Enter a product name, category, description, price, delivery mode, and product image",
        ),
      );
      return;
    }
    if (
      !Number.isSafeInteger(normalizedStock) ||
      normalizedStock < 0 ||
      normalizedStock > 1_000_000
    ) {
      onNotice(
        copy(
          "invalidProductStock",
          "库存请填 0 到 1000000 之间的整数",
          "Stock must be an integer between 0 and 1000000",
        ),
      );
      return;
    }
    if (!normalizedAmount) {
      onNotice(
        copy(
          "invalidProductPrice",
          "请填写有效的商品价格",
          "Enter a valid product price",
        ),
      );
      return;
    }
    if (!subplatform.domainId) {
      onNotice(
        copy(
          "platformIdentityIncompleteNotice",
          "店铺信息还没配置好，请联系商城工作人员",
          "This store has not finished its identity setup",
        ),
      );
      return;
    }
    if (
      usesLegacyMarketplace &&
      (!subplatform.assetSchemaId ||
        !pricingCurrency ||
        typeof pricingScale !== "number" ||
        !Number.isInteger(pricingScale) ||
        pricingScale < 0 ||
        pricingScale > 18)
    ) {
      onNotice(
        copy(
          "platformSchemaIncomplete",
          "店铺设置还没完成，请联系商城工作人员",
          "This store has incomplete product fields, currency, or price precision settings",
        ),
      );
      return;
    }
    const parsedAttributes: Record<string, unknown> = {
      description: productDescription.trim(),
      category: normalizedCategory,
      delivery_mode: deliveryMode,
      stock_quantity: normalizedStock,
    };
    const replacingUnresolvedTemplate = Boolean(
      usesProductTemplates &&
        editingOffer &&
        selectedProductTemplateId !==
          (editingOffer.productTemplateId ?? null) &&
        !editingSourceProductTemplate,
    );
    const knownTemplateFields = usesProductTemplates
      ? [
          ...(activeProductTemplateCatalog?.templates.flatMap(
            (template) => template.supplyFields,
          ) ?? []),
          ...(editingSourceProductTemplate?.supplyFields ?? []),
        ]
      : supplyFields;
    const attributesWithAttachments = {
      ...withoutSupplyFieldAttributes(
        knownTemplateFields,
        replacingUnresolvedTemplate ? {} : editingOffer?.attributes,
      ),
      ...parsedAttributes,
      ...serializedSupplyFields.attributes,
      attachments: attachments.map(publicAttachment),
    };

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
      onNotice(
        error instanceof Error
          ? error.message
          : copy(
              "platformSessionError",
              "店铺信息不完整，请联系商城工作人员",
              "This store's identity configuration is incomplete",
            ),
      );
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
      } else if (editingOffer) {
        record = await updateMarketplaceOffer({
          session,
          domainId: subplatform.domainId,
          offerId: editingOffer.offer_id,
          displayName: normalizedName,
          attributes: attributesWithAttachments,
          terms: {
            ...editingOffer.terms,
            pricing_mode: "fixed",
            amount_minor: normalizedAmount,
            currency: normalizedCurrency,
            currency_scale: pricingScale,
          },
          productTemplateId: usesProductTemplates
            ? selectedProductTemplateId
            : null,
          expectedVersion: editingOffer.version,
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
          productTemplateId: usesProductTemplates
            ? selectedProductTemplateId
            : null,
        });
        record = offer;
      }
      if (editingOffer && isMarketplaceOffer(record)) {
        setSubmissions((current) =>
          current.map((candidate) =>
            isMarketplaceOffer(candidate) &&
            candidate.offer_id === record.offer_id
              ? record
              : candidate,
          ),
        );
      } else {
        setSubmissions((current) => [record, ...current]);
      }
      const wasEditing = Boolean(editingOffer);
      resetOfferForm();
      setActivePanel("history");
      onNotice(
        copy(
          wasEditing ? "offerUpdatedNotice" : "offerSubmittedNotice",
          wasEditing
            ? "商品修改已保存，等待商城重新审核"
            : "商品已提交，商城审核通过后就会上架",
          wasEditing
            ? "Changes saved; the offer is awaiting review again"
            : "Offer submitted; it will appear after platform review",
        ),
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : copy(
              "offerSubmitError",
              "商品提交失败，请稍后再试",
              "Could not submit the offer; try again",
            ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dashboard seller-dashboard">
      {store ? (
        <StoreProductTemplateSettings
          storeId={store.id}
          canManageStore={canManageStore}
          catalog={activeProductTemplateCatalog}
          loading={productTemplatesLoading}
          error={productTemplatesError}
          onReload={() => void loadProductTemplates()}
          onCatalogChange={setProductTemplateCatalog}
          onNotice={onNotice}
          locale={locale}
        />
      ) : null}
      <div className="seller-settings-summary">
        <div>
          <strong>
            {subplatform.label || copy("currentPlatformLabel", "当前店铺")}
          </strong>
          <span>
            {submissions.length
              ? `${submissions.length} ${copy(
                  "offerCountUnitLabel",
                  "件商品",
                  "offers",
                )}`
              : copy("noSubmissionsLabel", "还没有商品")}
          </span>
        </div>
        <div className="seller-summary-actions">
          <span className="seller-mode-note">
            {copy("identityProtectionLabel", "账号和联系方式由商城保护")}
          </span>
          <button
            className="button button-dark"
            type="button"
            onClick={() => {
              resetOfferForm();
              setActivePanel("details");
            }}
            disabled={
              mediaUploading || submitting || productTemplateSubmitBlocked
            }
          >
            {copy("publishOfferAction", "发布商品", "Publish offer")}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <nav
        className="seller-settings-nav"
        role="tablist"
        aria-label={copy(
          "sellerSettingsSectionsLabel",
          "卖家功能分区",
          "Seller sections",
        )}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activePanel === "history"}
          aria-controls="seller-panel-history"
          className={activePanel === "history" ? "is-active" : ""}
          onClick={() => setActivePanel("history")}
          disabled={mediaUploading}
        >
          {copy("sellerHistoryTab", "商品列表", "Products")}
          <span>{submissions.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activePanel === "details"}
          aria-controls="seller-panel-details"
          className={activePanel === "details" ? "is-active" : ""}
          onClick={() => setActivePanel("details")}
          disabled={mediaUploading}
        >
          {editingOffer
            ? copy("sellerEditTab", "编辑商品", "Edit")
            : copy("sellerDetailsTab", "发布商品", "Publish")}
        </button>
        {usesLegacyMarketplace ? null : (
          <button
            type="button"
            role="tab"
            aria-selected={activePanel === "demand"}
            aria-controls="seller-panel-demand"
            className={activePanel === "demand" ? "is-active" : ""}
            onClick={() => setActivePanel("demand")}
            disabled={mediaUploading}
          >
            {copy("sellerDemandTab", "找买家", "Find buyers")}
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={activePanel === "contacts"}
          aria-controls="seller-panel-contacts"
          className={activePanel === "contacts" ? "is-active" : ""}
          onClick={() => setActivePanel("contacts")}
          disabled={mediaUploading}
        >
          {copy("sellerContactsTab", "联系申请", "Contacts")}
          <span>{introductions.length}</span>
        </button>
      </nav>

      <div
        id="seller-panel-details"
        className="seller-settings-panel"
        role="tabpanel"
        hidden={activePanel !== "details"}
      >
        <section
          className="surface seller-upload"
          aria-labelledby="seller-upload-title"
        >
          <SectionHeading
            titleId="seller-upload-title"
            title={
              editingOffer
                ? copy("editOfferTitle", "编辑商品", "Edit offer")
                : copy("uploadTitle", "发布商品", "Publish offer")
            }
            action={
              editingOffer
                ? copy("cancelOfferEditAction", "取消编辑", "Cancel edit")
                : copy(
                    "backToOfferListAction",
                    "返回商品列表",
                    "Back to offers",
                  )
            }
            onAction={() => {
              if (mediaUploading || submitting) return;
              if (editingOffer) cancelOfferEdit();
              else setActivePanel("history");
            }}
          />
          <p className="seller-upload-intro">
            {editingOffer
              ? copy(
                  "editOfferIntro",
                  "保存后商品会回到待审核状态，商城审核通过后买家才能看到新内容。",
                  "After saving, the offer returns to review and stays hidden until approved.",
                )
              : copy(
                  "createOfferIntro",
                  "填写买家真正需要看到的信息。提交后商城会先审核，通过后才会公开展示。",
                  "Add the information buyers need. The offer becomes public only after review.",
                )}
          </p>
          {editingOffer ? (
            <div className="seller-edit-notice" role="status">
              {copy("editingOfferLabel", "正在编辑", "Editing")}“
              {editingOffer.display_name}” ·{" "}
              {copy("currentOfferVersionLabel", "当前版本", "Current version")}{" "}
              {editingOffer.version}
            </div>
          ) : null}
          {agentDraft && !editingOffer ? (
            <div className="seller-agent-draft" role="status">
              <div>
                <strong>
                  {copy(
                    "agentDraftTitle",
                    "对话草稿已准备好",
                    "Conversation draft ready",
                  )}
                </strong>
                <p>{agentDraft.narrative}</p>
              </div>
              <button
                className="text-action"
                type="button"
                onClick={importAgentDraft}
                disabled={draftImported || mediaUploading || submitting}
              >
                {draftImported
                  ? copy(
                      "agentDraftImportedLabel",
                      "已放入编辑器",
                      "Added to editor",
                    )
                  : copy(
                      "agentDraftImportLabel",
                      "放入编辑器",
                      "Add to editor",
                    )}
              </button>
            </div>
          ) : null}
          <form className="seller-upload-form" onSubmit={submit} noValidate>
            {store &&
            (productTemplatesLoading ||
              productTemplatesError ||
              usesProductTemplates) ? (
              <ProductTemplateSelector
                templates={enabledProductTemplates}
                selectedTemplateId={selectedProductTemplateId}
                sourceTemplate={selectedProductTemplate ?? null}
                values={supplyFieldValues}
                onConfirm={(selection) => {
                  const nextTemplate = enabledProductTemplates.find(
                    (template) => template.id === selection.templateId,
                  );
                  if (!nextTemplate) {
                    onNotice(
                      locale === "en"
                        ? "That product template is no longer enabled. Refresh the policy and choose again."
                        : "该商品模板已不再启用，请刷新设置后重新选择。",
                    );
                    return;
                  }
                  setSelectedProductTemplateId(nextTemplate.id);
                  setDraftProductTemplate(nextTemplate);
                  setCategory(nextTemplate.category ?? "");
                  setSupplyFieldValues(selection.values);
                }}
                onRefresh={() => void loadProductTemplates()}
                locale={locale}
                loading={productTemplatesLoading}
                error={productTemplatesError}
                invalidReason={productTemplateInvalidReason}
                disabled={mediaUploading || submitting}
              />
            ) : null}
            <div className="seller-media-uploader seller-upload-wide">
              <div className="seller-media-uploader-heading">
                <div>
                  <strong>
                    {copy("offerMediaTitle", "商品图片", "Offer images")}
                  </strong>
                  <small>
                    {copy(
                      "offerMediaHelp",
                      "上传清晰实拍图，至少一张；第一张作为商品封面。",
                      "Add at least one clear real photo; the first image is the cover.",
                    )}
                  </small>
                </div>
                <button
                  className="text-action seller-media-picker"
                  type="button"
                  disabled={
                    mediaUploading || submitting || attachments.length >= 8
                  }
                  aria-busy={mediaUploading}
                  onClick={() => mediaInputRef.current?.click()}
                >
                  <FileUp size={16} aria-hidden="true" />
                  {mediaUploading
                    ? copy("mediaUploadingLabel", "上传中…", "Uploading…")
                    : attachments.length
                      ? copy(
                          "mediaAddMoreLabel",
                          "继续添加图片",
                          "Add more images",
                        )
                      : copy("uploadMediaLabel", "上传图片", "Upload images")}
                </button>
                <input
                  ref={mediaInputRef}
                  id="seller-media-input"
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  disabled={
                    mediaUploading || submitting || attachments.length >= 8
                  }
                  onChange={(event) => {
                    void uploadFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              {attachments.length ? (
                <ul
                  className="seller-media-list"
                  aria-label={copy(
                    "mediaListLabel",
                    "已上传的图片",
                    "Uploaded images",
                  )}
                >
                  {attachments.map((attachment, index) => (
                    <li key={attachment.attachment_ref}>
                      <span title={attachment.file_name}>
                        {attachment.file_name}
                      </span>
                      <small>
                        {formatAttachmentSize(attachment.size_bytes)}
                      </small>
                      {index === 0 ? (
                        <span className="seller-media-cover">
                          {copy("mediaCoverLabel", "封面", "Cover")}
                        </span>
                      ) : null}
                      <div className="seller-media-item-actions">
                        {index > 0 ? (
                          <button
                            className="seller-media-cover-action"
                            type="button"
                            onClick={() =>
                              setAttachments((current) => {
                                const currentIndex = current.findIndex(
                                  (item) =>
                                    item.attachment_ref ===
                                    attachment.attachment_ref,
                                );
                                if (currentIndex <= 0) return current;
                                const next = [...current];
                                const [cover] = next.splice(currentIndex, 1);
                                return cover ? [cover, ...next] : current;
                              })
                            }
                            disabled={mediaUploading || submitting}
                          >
                            {copy(
                              "setMediaCoverLabel",
                              "设为封面",
                              "Set as cover",
                            )}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`${copy(
                            "removeMediaLabel",
                            "删除图片",
                            "Remove image",
                          )} ${attachment.file_name}`}
                          onClick={() =>
                            setAttachments((current) =>
                              current.filter(
                                (item) =>
                                  item.attachment_ref !==
                                  attachment.attachment_ref,
                              ),
                            )
                          }
                          disabled={mediaUploading || submitting}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          <span>
                            {copy("removeMediaAction", "删除", "Remove")}
                          </span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <label htmlFor="seller-display-name">
              <span>{copy("offerNameLabel", "商品名称", "Offer name")}</span>
              <input
                id="seller-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={copy(
                  "offerNamePlaceholder",
                  "写清品牌、型号或商品内容",
                  "Describe the brand, model, or offer clearly",
                )}
                maxLength={500}
                required
              />
            </label>
            <label htmlFor="seller-category">
              <span>{copy("offerCategoryLabel", "商品分类", "Category")}</span>
              <input
                id="seller-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder={copy(
                  "offerCategoryPlaceholder",
                  "填写你的商品分类",
                  "Enter a category",
                )}
                maxLength={120}
                required
              />
            </label>
            <label
              className="seller-upload-wide"
              htmlFor="seller-product-description"
            >
              <span>
                {copy("offerDescriptionLabel", "商品描述", "Description")}
              </span>
              <textarea
                id="seller-product-description"
                value={productDescription}
                onChange={(event) => setProductDescription(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder={copy(
                  "offerDescriptionPlaceholder",
                  "介绍商品特点、包含内容、使用条件和交付说明",
                  "Describe what is included, key details, conditions, and delivery",
                )}
                required
              />
            </label>
            {supplyFields.length ? (
              <SupplyFieldEditor
                fields={supplyFields}
                values={supplyFieldValues}
                onValueChange={(key, value) =>
                  setSupplyFieldValues((current) => ({
                    ...current,
                    [key]: value,
                  }))
                }
                disabled={mediaUploading || submitting}
                locale={locale}
              />
            ) : null}
            <label htmlFor="seller-asking-amount">
              <span>
                {copy("priceLabel", "价格")}
                {currency ? `（${currency}）` : ""}
              </span>
              <input
                id="seller-asking-amount"
                value={askingAmount}
                onChange={(event) => setAskingAmount(event.target.value)}
                inputMode="decimal"
                placeholder={amountPlaceholder(pricingScale, locale)}
                required
              />
            </label>
            <label htmlFor="seller-delivery-mode">
              <span>{copy("deliveryModeLabel", "交付方式", "Delivery")}</span>
              <select
                id="seller-delivery-mode"
                value={deliveryMode}
                onChange={(event) =>
                  setDeliveryMode(event.target.value as typeof deliveryMode)
                }
                required
              >
                <option value="">
                  {copy(
                    "deliveryModePlaceholder",
                    "选择交付方式",
                    "Choose delivery",
                  )}
                </option>
                <option value="digital">
                  {copy(
                    "digitalDeliveryLabel",
                    "线上发送（不用邮寄）",
                    "Digital delivery",
                  )}
                </option>
                <option value="shipping">
                  {copy("shippingDeliveryLabel", "快递发货", "Shipping")}
                </option>
                <option value="service">
                  {copy(
                    "serviceDeliveryLabel",
                    "到店或上门服务",
                    "In-store or on-site service",
                  )}
                </option>
              </select>
            </label>
            <label htmlFor="seller-stock">
              <span>
                {copy("offerStockLabel", "可售库存", "Available stock")}
              </span>
              <input
                id="seller-stock"
                value={stockQuantity}
                onChange={(event) => setStockQuantity(event.target.value)}
                type="number"
                min={0}
                max={1000000}
                step={1}
                required
              />
              <small>
                {copy(
                  "offerStockHelp",
                  "填 0 表示暂时售罄",
                  "Enter 0 when temporarily sold out",
                )}
              </small>
            </label>
            <div className="seller-upload-actions seller-upload-wide">
              <p>
                <FileUp size={17} aria-hidden="true" />{" "}
                {copy(
                  "reviewNotice",
                  "提交后商城会先审核，审核通过才会展示给买家。",
                )}
              </p>
              <motion.button
                className="button button-dark"
                type="submit"
                disabled={
                  submitting ||
                  mediaUploading ||
                  productTemplateSubmitBlocked ||
                  !isLiveMarketplaceEnabled() ||
                  !subplatform.domainId ||
                  (usesLegacyMarketplace &&
                    (!subplatform.assetSchemaId ||
                      !pricingCurrency ||
                      !Number.isInteger(pricingScale)))
                }
                title={
                  isLiveMarketplaceEnabled()
                    ? undefined
                    : copy(
                        "supplyApiUnavailableNotice",
                        "当前环境暂时无法发布商品，内容不会被保存",
                        "The live supply API is disabled; nothing will be saved",
                      )
                }
                whileTap={{ scale: 0.97 }}
                transition={spring}
              >
                {submitting
                  ? editingOffer
                    ? copy("savingOfferLabel", "正在保存…", "Saving…")
                    : copy("submittingLabel", "正在提交…")
                  : editingOffer
                    ? copy(
                        "saveForReviewLabel",
                        "保存并重新提交审核",
                        "Save and resubmit for review",
                      )
                    : copy("submitForReviewLabel", "上传并提交审核")}
                {submitting ? null : (
                  <ArrowRight size={18} aria-hidden="true" />
                )}
              </motion.button>
            </div>
          </form>
        </section>
      </div>

      <section
        id="seller-panel-history"
        className="surface seller-submissions seller-settings-panel"
        role="tabpanel"
        hidden={activePanel !== "history"}
        aria-labelledby="seller-submissions-title"
      >
        <SectionHeading
          titleId="seller-submissions-title"
          title={copy("submissionHistoryTitle", "商品列表", "Offers")}
          action={copy("publishOfferAction", "发布商品", "Publish offer")}
          onAction={() => {
            resetOfferForm();
            setActivePanel("details");
          }}
        />
        {submissionsLoading ? (
          <div className="seller-empty-state">
            <FileUp size={24} aria-hidden="true" />
            <p>
              {copy(
                "loadingSubmissionsLabel",
                "正在加载你的商品…",
                "Loading your submissions…",
              )}
            </p>
          </div>
        ) : submissionsError ? (
          <div className="seller-empty-state">
            <FileUp size={24} aria-hidden="true" />
            <p>{submissionsError}</p>
            <button type="button" onClick={() => void loadSubmissions()}>
              {copy("reloadSubmissionsLabel", "重新加载", "Reload")}
            </button>
          </div>
        ) : submissions.length ? (
          <ol className="submission-list">
            {submissions.map((submission) => {
              const offer = isMarketplaceOffer(submission) ? submission : null;
              const withdrawing = offer
                ? withdrawingOfferIds.has(offer.offer_id)
                : false;
              const submissionId = sellerRecordId(submission);
              return (
                <li
                  key={submissionId}
                  ref={(node) => {
                    if (node) submissionRowRefs.current.set(submissionId, node);
                    else submissionRowRefs.current.delete(submissionId);
                  }}
                  tabIndex={-1}
                >
                  <div>
                    <strong>{submission.display_name}</strong>
                    <small>
                      {sellerRecordPrice(submission, pricing, locale)} ·{" "}
                      {formatSubmissionDate(submission.updated_at, locale)}
                    </small>
                    {"review_reason" in submission &&
                    submission.review_reason ? (
                      <small className="submission-review-reason">
                        {submission.review_reason}
                      </small>
                    ) : null}
                  </div>
                  <div className="submission-controls">
                    <span className="submission-status">
                      {submissionStatusLabel(submission.status, locale)}
                    </span>
                    {offer && canEditMarketplaceOffer(offer) ? (
                      <div className="submission-actions">
                        <button
                          className="text-action seller-record-action"
                          type="button"
                          onClick={() => beginOfferEdit(offer)}
                          disabled={
                            submitting ||
                            withdrawing ||
                            Boolean(
                              store &&
                                (productTemplatesLoading ||
                                  productTemplatesError),
                            )
                          }
                        >
                          <Pencil size={14} aria-hidden="true" />
                          {copy("editOfferAction", "编辑", "Edit")}
                        </button>
                        {canWithdrawMarketplaceOffer(offer) ? (
                          withdrawConfirmId === offer.offer_id ? (
                            <div
                              className="submission-confirm"
                              role="group"
                              aria-label={copy(
                                "withdrawConfirmLabel",
                                `确认${offer.status === "draft" ? "删除" : "下架"} ${offer.display_name}`,
                                `Confirm ${offer.status === "draft" ? "deletion" : "withdrawal"} of ${offer.display_name}`,
                              )}
                            >
                              <span>
                                {copy(
                                  "withdrawConfirmQuestion",
                                  offer.status === "draft"
                                    ? "确认删除草稿？"
                                    : "确认下架？",
                                  offer.status === "draft"
                                    ? "Delete this draft?"
                                    : "Withdraw this offer?",
                                )}
                              </span>
                              <button
                                className="text-action seller-record-action is-destructive"
                                type="button"
                                onClick={() => void withdrawOffer(offer)}
                                disabled={withdrawing}
                              >
                                {withdrawing
                                  ? copy(
                                      "withdrawingOfferLabel",
                                      "下架中…",
                                      "Withdrawing…",
                                    )
                                  : copy(
                                      "confirmWithdrawAction",
                                      offer.status === "draft"
                                        ? "确认删除"
                                        : "确认下架",
                                      "Confirm",
                                    )}
                              </button>
                              <button
                                className="text-action seller-record-action"
                                type="button"
                                onClick={() => setWithdrawConfirmId(null)}
                                disabled={withdrawing}
                              >
                                {copy("cancelAction", "取消", "Cancel")}
                              </button>
                            </div>
                          ) : (
                            <button
                              className="text-action seller-record-action is-destructive"
                              type="button"
                              aria-expanded={false}
                              onClick={() =>
                                setWithdrawConfirmId(offer.offer_id)
                              }
                              disabled={withdrawing}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              {copy(
                                "withdrawOfferAction",
                                offer.status === "draft" ? "删除" : "下架",
                                offer.status === "draft"
                                  ? "Delete"
                                  : "Withdraw",
                              )}
                            </button>
                          )
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="seller-empty-state seller-product-empty">
            <FileUp size={24} aria-hidden="true" />
            <strong>
              {copy("noSubmissionsLabel", "还没有商品", "No offers yet")}
            </strong>
            <p>
              {copy(
                "firstOfferHelp",
                "发布第一件商品，审核通过后买家就能在商城看到。",
                "Publish your first offer; buyers can see it after approval.",
              )}
            </p>
            <button
              className="button button-dark"
              type="button"
              onClick={() => setActivePanel("details")}
            >
              {copy(
                "publishFirstOfferAction",
                "发布第一件商品",
                "Publish your first offer",
              )}
            </button>
          </div>
        )}
      </section>

      {usesLegacyMarketplace ? null : (
        <section
          id="seller-panel-demand"
          className="surface seller-submissions seller-demand-discovery seller-settings-panel"
          role="tabpanel"
          hidden={activePanel !== "demand"}
          aria-labelledby="seller-demand-title"
        >
          <SectionHeading
            titleId="seller-demand-title"
            eyebrow={copy("demandDiscoveryEyebrow", "找买家")}
            title={copy("demandDiscoveryTitle", "看看哪些买家在找货")}
          />
          <p className="seller-discovery-intro">
            {copy(
              "demandDiscoveryDescription",
              "这里只显示愿意让商家看到的买家求购信息。买家联系你后，双方都同意才会交换联系方式。",
            )}
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
                        <small>
                          {offer.external_key} ·{" "}
                          {copy("publishedLabel", "已发布", "Published")}
                        </small>
                      </div>
                      <button
                        className="text-action"
                        type="button"
                        onClick={() => void findDemandMatches(offer)}
                        disabled={loading}
                      >
                        {loading
                          ? copy(
                              "findingDemandLabel",
                              "寻找中…",
                              "Finding demand…",
                            )
                          : matches
                            ? copy(
                                "refindDemandLabel",
                                "重新寻找",
                                "Search again",
                              )
                            : copy("findDemandLabel", "找买家", "Find buyers")}
                        <ArrowRight size={15} aria-hidden="true" />
                      </button>
                    </div>
                    {error ? (
                      <p className="seller-demand-error" role="alert">
                        {error}
                      </p>
                    ) : null}
                    {matches ? (
                      matches.length ? (
                        <ol className="seller-demand-list">
                          {matches.map((demand) => {
                            return (
                              <li key={demand.intent_id}>
                                <div>
                                  <strong>{demand.narrative}</strong>
                                  <small>
                                    {demandMatchLevel(demand.score, locale)} ·{" "}
                                    {copy("relevanceLabel", "相关", "relevant")}
                                    {demand.reasons.length
                                      ? ` · ${demand.reasons.slice(0, 2).join(locale === "en" ? ", " : "、")}`
                                      : ""}
                                  </small>
                                </div>
                                <span className="submission-status">
                                  {copy(
                                    "waitingDemandContactLabel",
                                    "等买家来联系",
                                    "Waiting for the buyer to make contact",
                                  )}
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      ) : (
                        <div className="seller-empty-state seller-demand-empty">
                          <p>
                            {copy(
                              "noDemandMatchesLabel",
                              "暂时没有合适的买家在找这类商品。",
                              "No matching published demand yet.",
                            )}
                          </p>
                        </div>
                      )
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="seller-empty-state seller-demand-empty">
              <p>
                {copy(
                  "demandDiscoveryEmptyLabel",
                  "商品审核通过、上架后，就可以在这里找买家。",
                  "Once an offer is approved and published, you can find buyers here.",
                )}
              </p>
            </div>
          )}
        </section>
      )}

      <div
        id="seller-panel-contacts"
        className="seller-settings-panel"
        role="tabpanel"
        hidden={activePanel !== "contacts"}
      >
        <section
          className="surface seller-submissions"
          aria-labelledby="seller-introductions-title"
        >
          <SectionHeading
            titleId="seller-introductions-title"
            eyebrow={copy("contactRequestsEyebrow", "联系申请")}
            title={copy(
              "contactRequestsTitle",
              "需要你明确同意，才会交换联系方式",
            )}
          />
          {introductionsError ? (
            <div className="seller-empty-state">
              <p>{introductionsError}</p>
            </div>
          ) : introductions.length ? (
            <ol className="submission-list">
              {introductions.map((introduction) => (
                <li key={introduction.introduction_id}>
                  <div>
                    <strong>
                      {copy("contactRequestLabel", "有买家想和你联系")}
                    </strong>
                    <small>
                      {introductionStatusLabel(introduction.status, locale)} ·{" "}
                      {formatSubmissionDate(introduction.created_at, locale)}
                    </small>
                    {releasedContacts[introduction.introduction_id] ? (
                      <div className="buyer-contact-values">
                        {Object.entries(
                          releasedContacts[introduction.introduction_id]
                            .counterpart.contact,
                        ).map(([key, value]) => (
                          <span key={key}>
                            {subplatformContactLabel(subplatform, key)}: {value}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {releasedContacts[introduction.introduction_id] ? (
                    <span className="submission-status">
                      {copy("contactVisibleLabel", "已可联系")}
                    </span>
                  ) : introduction.supply_contact_consent_at ? (
                    <button
                      className="text-action"
                      type="button"
                      onClick={() => void releaseContact(introduction)}
                      disabled={
                        releasingContactId === introduction.introduction_id
                      }
                    >
                      {releasingContactId === introduction.introduction_id
                        ? copy("contactReadingLabel", "读取中…")
                        : copy("viewContactLabel", "查看对方联系方式")}
                    </button>
                  ) : introduction.status === "contact_requested" ? (
                    <button
                      className="text-action"
                      type="button"
                      onClick={() => void consent(introduction)}
                      disabled={
                        consentingIntroductionId ===
                        introduction.introduction_id
                      }
                    >
                      {consentingIntroductionId === introduction.introduction_id
                        ? copy("processingLabel", "处理中…")
                        : copy("consentContactLabel", "同意交换")}
                    </button>
                  ) : (
                    <span className="submission-status">
                      {copy(
                        "waitingBuyerConfirmationLabel",
                        "等买家确认",
                        "Waiting for the buyer to confirm",
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="seller-empty-state">
              <p>{copy("noContactRequestsLabel", "还没有买家申请联系你。")}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function amountPlaceholder(
  scale: number,
  locale: InterfaceLocale = "zh",
): string {
  return locale === "en"
    ? scale > 0
      ? `e.g. 1000.${"0".repeat(Math.min(scale, 2))}`
      : "e.g. 1000"
    : scale > 0
      ? `例如 1000.${"0".repeat(Math.min(scale, 2))}`
      : "例如 1000";
}

function unresolvedProductTemplateFieldValues(
  attributes: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      [
        "attachments",
        "category",
        "delivery_mode",
        "description",
        "images",
        "image_url",
        "media",
        "photo_url",
        "stock_quantity",
        "video_url",
      ].includes(key) ||
      value === null ||
      value === undefined
    ) {
      continue;
    }
    values[key] =
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
        ? String(value)
        : "[value]";
  }
  return values;
}

function marketplaceOfferAttachments(
  attributes: Record<string, unknown>,
): MarketplaceAttachment[] {
  const value = attributes.attachments;
  if (!Array.isArray(value)) return [];
  return value
    .map(parseMarketplaceOfferAttachment)
    .filter(
      (attachment): attachment is MarketplaceAttachment => attachment !== null,
    );
}

function parseMarketplaceOfferAttachment(
  candidate: unknown,
): MarketplaceAttachment | null {
  if (!isObjectRecord(candidate)) return null;
  const kind = marketplaceAttachmentKind(candidate.kind);
  const attachmentRef = stringValue(candidate.attachment_ref);
  const fileName = stringValue(candidate.file_name);
  const mediaType = stringValue(candidate.media_type);
  const sha256 = stringValue(candidate.sha256);
  const sizeBytes = safeIntegerValue(candidate.size_bytes);
  if (
    !kind ||
    !attachmentRef ||
    !fileName ||
    !mediaType ||
    !sha256 ||
    sizeBytes === null
  )
    return null;
  return {
    attachment_ref: attachmentRef,
    kind,
    file_name: fileName,
    media_type: mediaType,
    size_bytes: sizeBytes,
    sha256,
    ...optionalNumber("width", candidate.width),
    ...optionalNumber("height", candidate.height),
    ...optionalNumber("duration_ms", candidate.duration_ms),
    ...(isObjectRecord(candidate.metadata)
      ? { metadata: candidate.metadata }
      : {}),
  };
}

function marketplaceAttachmentKind(
  value: unknown,
): MarketplaceAttachment["kind"] | null {
  const kinds: MarketplaceAttachment["kind"][] = [
    "image",
    "document",
    "video",
    "audio",
    "file",
  ];
  return typeof value === "string" &&
    kinds.includes(value as MarketplaceAttachment["kind"])
    ? (value as MarketplaceAttachment["kind"])
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function safeIntegerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function optionalNumber(key: string, value: unknown): Record<string, number> {
  return typeof value === "number" ? { [key]: value } : {};
}

function publicAttachment(
  attachment: MarketplaceAttachment,
): Record<string, unknown> {
  return {
    attachment_ref: attachment.attachment_ref,
    kind: attachment.kind,
    file_name: attachment.file_name,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
    ...(attachment.duration_ms === undefined
      ? {}
      : { duration_ms: attachment.duration_ms }),
    ...(attachment.metadata === undefined
      ? {}
      : { metadata: attachment.metadata }),
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
    return bounded >= 0.8
      ? "Strong fit"
      : bounded >= 0.6
        ? "Good fit"
        : bounded >= 0.4
          ? "Possible fit"
          : "Weak fit";
  }
  return bounded >= 0.8
    ? "非常适合"
    : bounded >= 0.6
      ? "比较适合"
      : bounded >= 0.4
        ? "一般"
        : "不太适合";
}

function sellerRecordId(record: SellerRecord): string {
  return "submission_id" in record ? record.submission_id : record.offer_id;
}

function isMarketplaceOffer(record: SellerRecord): record is MarketplaceOffer {
  return "offer_id" in record;
}

function canEditMarketplaceOffer(offer: MarketplaceOffer): boolean {
  return (
    offer.status === "draft" ||
    offer.status === "active" ||
    offer.status === "withdrawn"
  );
}

function canWithdrawMarketplaceOffer(offer: MarketplaceOffer): boolean {
  return offer.status === "draft" || offer.status === "active";
}

function fromMinorUnits(value: string, scale: number): string {
  if (!/^[0-9]+$/.test(value) || !Number.isInteger(scale) || scale < 0)
    return "";
  const normalized = value.replace(/^0+(?=\d)/, "");
  if (scale === 0) return normalized;
  const padded = normalized.padStart(scale + 1, "0");
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sellerRecordPrice(
  record: SellerRecord,
  pricing: { mode: string },
  locale: InterfaceLocale = "zh",
): string {
  if ("asking_amount" in record) {
    return formatMinorUnits(
      record.asking_amount,
      record.currency,
      record.currency_scale,
    );
  }
  const amount = record.terms.amount_minor;
  const currency = record.terms.currency;
  const scale = record.terms.currency_scale;
  if (
    typeof amount === "string" &&
    typeof currency === "string" &&
    typeof scale === "number" &&
    Number.isInteger(scale)
  ) {
    return formatMinorUnits(amount, currency, scale);
  }
  const display = stringAttribute(record.terms, [
    "display_price",
    "price_label",
    "price",
  ]);
  const min = record.terms.amount_min_minor;
  const max = record.terms.amount_max_minor;
  if (
    typeof min === "string" &&
    typeof max === "string" &&
    typeof currency === "string" &&
    typeof scale === "number"
  ) {
    return `${formatMinorUnits(min, currency, scale)} – ${formatMinorUnits(max, currency, scale)}`;
  }
  if (
    typeof record.terms.pricing_note === "string" &&
    record.terms.pricing_note.trim()
  )
    return record.terms.pricing_note.trim();
  return (
    display ||
    (pricing.mode === "none" ? "—" : locale === "en" ? "To be added" : "待补充")
  );
}

function stringAttribute(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim())
      return value[key].trim();
  }
  return undefined;
}

function formatMinorUnits(
  amount: string,
  currency: string,
  scale: number,
): string {
  try {
    const value = BigInt(amount);
    const negative = value < 0n;
    const absolute = (negative ? -value : value)
      .toString()
      .padStart(scale + 1, "0");
    const splitAt = absolute.length - scale;
    const integer = (
      scale === 0 ? absolute : absolute.slice(0, splitAt)
    ).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (scale === 0) return `${currency} ${negative ? "-" : ""}${integer}`;
    return `${currency} ${negative ? "-" : ""}${integer}.${absolute.slice(splitAt)}`;
  } catch {
    return `${currency} ${amount}`;
  }
}

function formatSubmissionDate(
  value: string,
  locale: InterfaceLocale = "zh",
): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? locale === "en"
      ? "Unknown time"
      : "时间未知"
    : date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN");
}

function submissionStatusLabel(
  status: string,
  locale: InterfaceLocale = "zh",
): string {
  if (locale === "en") {
    return (
      {
        draft: "In review",
        pending_review: "In review",
        active: "Published",
        approved: "Approved",
        rejected: "Needs changes",
        suspended: "Paused",
        withdrawn: "Withdrawn",
        closed: "Closed",
      }[status] ?? status
    );
  }
  return (
    {
      draft: "待审核",
      pending_review: "待审核",
      active: "已上架",
      approved: "已通过",
      rejected: "需修改",
      suspended: "已暂停",
      withdrawn: "已下架",
      closed: "已结束",
    }[status] ?? status
  );
}

function introductionStatusLabel(
  status: string,
  locale: InterfaceLocale = "zh",
): string {
  if (locale === "en") {
    return (
      {
        proposed: "Match created",
        contact_requested: "Waiting for your approval",
        contact_released: "Exchange approved",
        completed: "Completed",
        declined: "Declined",
        expired: "Expired",
        disputed: "Under review",
      }[status] ?? "Matching in progress"
    );
  }
  return (
    {
      proposed: "已匹配到买家",
      contact_requested: "等待你的同意",
      contact_released: "已同意交换",
      completed: "已完成",
      declined: "已拒绝",
      expired: "已过期",
      disputed: "处理中",
    }[status] ?? "处理中"
  );
}

function toMinorUnits(value: string, scale: number): string | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > scale) return null;
  const result =
    `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(result) > 0n ? result : null;
}
