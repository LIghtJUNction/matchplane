"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, FileUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { motion } from "motion/react";

import {
  consentMarketplaceContact,
  createMarketplaceOffer,
  getMarketplaceIntroductions,
  getMarketplaceOffers,
  getSellerListingSubmissions,
  isLiveMarketplaceEnabled,
  type MarketplaceIntroduction,
  type MarketplaceOffer,
  submitSellerListing,
  type ListingSubmission,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { pricingFor, type SubplatformConfig } from "../subplatform";
import { SectionHeading, spring } from "./Primitives";

interface SellerDashboardProps {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}

type SellerRecord = ListingSubmission | MarketplaceOffer;

/** Generic seller surface. The active subplatform owns the meaning of `attributes`. */
export function SellerDashboard({ onNotice, subplatform }: SellerDashboardProps) {
  const [externalKey, setExternalKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [askingAmount, setAskingAmount] = useState("");
  const pricing = pricingFor(subplatform);
  const isFixedPrice = pricing.mode === "fixed";
  const pricingCurrency = pricing.currency ?? subplatform.currency;
  const pricingScale = pricing.currencyScale ?? subplatform.currencyScale;
  const [currency, setCurrency] = useState(pricingCurrency ?? "");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<Array<{ id: string; key: string; value: string }>>([]);
  const [advancedAttributes, setAdvancedAttributes] = useState("{}");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<SellerRecord[]>([]);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [introductions, setIntroductions] = useState<MarketplaceIntroduction[]>([]);
  const [introductionsError, setIntroductionsError] = useState<string | null>(null);
  const [consentingIntroductionId, setConsentingIntroductionId] = useState<string | null>(null);

  const loadSubmissions = useCallback(async () => {
    setSubmissions([]);
    setIntroductions([]);
    setSubmissionsError(null);
    setIntroductionsError(null);
    if (!isLiveMarketplaceEnabled()) {
      setSubmissionsError("当前部署未启用真实供给 API");
      return;
    }
    if (!subplatform.domainId || !subplatform.tenantId) {
      setSubmissionsError("当前子平台还没有完成身份配置");
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
        setSubmissionsError("请先登录后查看你的提交记录");
        return;
      }
      if (isFixedPrice) {
        setSubmissions(await getSellerListingSubmissions({ session, domainId: subplatform.domainId }));
      } else {
        setSubmissions(await getMarketplaceOffers({ session, domainId: subplatform.domainId }));
      }
      setIntroductions(await getMarketplaceIntroductions({ session, domainId: subplatform.domainId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交记录读取失败";
      setSubmissionsError(message);
      setIntroductionsError(message);
    } finally {
      setSubmissionsLoading(false);
    }
  }, [isFixedPrice, subplatform.domainId, subplatform.path, subplatform.slug, subplatform.tenantId]);

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
        onNotice("请先登录后处理联系申请");
        return;
      }
      const updated = await consentMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
      });
      setIntroductions((current) => current.map((item) => item.introduction_id === updated.introduction_id ? updated : item));
      onNotice("已同意交换联系方式，买方可以查看你提供的联系渠道");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "联系申请处理失败");
    } finally {
      setConsentingIntroductionId(null);
    }
  };

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  useEffect(() => {
    setCurrency(pricingCurrency ?? "");
  }, [pricingCurrency]);

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
    const normalizedKey = externalKey.trim();
    const normalizedCurrency = currency.trim().toUpperCase();
    const normalizedAmount = isFixedPrice ? toMinorUnits(askingAmount, pricingScale ?? 0) : null;
    if (!normalizedKey || !normalizedName || (isFixedPrice && (!normalizedAmount || !normalizedCurrency))) {
      onNotice(isFixedPrice ? "请完整填写名称、编号、报价和结算币种" : "请完整填写供给名称和编号");
      return;
    }
    if (!isLiveMarketplaceEnabled()) {
      onNotice("当前环境未启用真实供给 API，资料没有写入系统");
      return;
    }
    if (!subplatform.domainId) {
      onNotice("当前子平台尚未完成身份配置");
      return;
    }
    if (isFixedPrice && (!subplatform.assetSchemaId || !pricingCurrency
      || typeof pricingScale !== "number"
      || !Number.isInteger(pricingScale)
      || pricingScale < 0 || pricingScale > 18)) {
      onNotice("当前子平台尚未配置完整的资料 schema、结算币种和价格精度");
      return;
    }
    const missing = schemaFields.find((field) => field.required && !fieldValues[field.key]?.trim());
    if (missing) {
      onNotice(`请填写${missing.label}`);
      return;
    }
    const parsedAttributes = attributesFromForm(fieldValues, customFields, schemaFields, advancedOpen ? advancedAttributes : null);
    if (!parsedAttributes) {
      onNotice("高级资料必须是有效的 JSON 对象");
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
      onNotice(error instanceof Error ? error.message : "当前子平台身份配置不完整");
      return;
    }
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?role=seller&next=${encodeURIComponent(next)}`);
      return;
    }
    setSubmitting(true);
    try {
      const record: SellerRecord = isFixedPrice
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
              ...(pricing.label ? { pricing_label: pricing.label } : {}),
            },
          });
      setSubmissions((current) => [record, ...current]);
      setExternalKey("");
      setDisplayName("");
      setAskingAmount("");
      setCurrency(pricingCurrency ?? "");
      setFieldValues({});
      setCustomFields([]);
      setAdvancedAttributes("{}");
      setAdvancedOpen(false);
      onNotice("供给已提交，等待平台审核后展示");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "供给提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dashboard seller-dashboard">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">供给方工作台 · {subplatform.label || "当前子平台"}</p>
          <h1>由你上传真实资料，平台帮你找到合适的需求。</h1>
          <p>根平台不预置任何商品样例。提交后先进入审核队列，审核通过才会进入 AI 撮合。</p>
        </div>
        <span className="seller-mode-note"><ShieldCheck size={16} aria-hidden="true" /> 账号和联系方式由根平台保护</span>
      </section>

      <section className="seller-status-summary" aria-label="供给资料状态">
        <FileUp size={19} aria-hidden="true" />
        <div><strong>{submissions.length ? `已提交 ${submissions.length} 份资料` : "还没有提交资料"}</strong><small>提交后会进入当前子平台的审核流程</small></div>
      </section>

      <section className="surface seller-upload" aria-labelledby="seller-upload-title">
        <SectionHeading eyebrow="资料上传" title="提交一份新的供给资料" />
        <p className="seller-upload-intro">
          字段由当前子平台的 schema 定义。根平台只保存结构化 JSON，不会替商家猜测或填充领域信息。
        </p>
        <form className="seller-upload-form" onSubmit={submit}>
          <label htmlFor="seller-display-name">
            <span>供给名称</span>
            <input id="seller-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="由你填写" maxLength={500} required />
          </label>
          <label htmlFor="seller-external-key">
            <span>内部编号</span>
            <input id="seller-external-key" value={externalKey} onChange={(event) => setExternalKey(event.target.value)} placeholder="用于管理这份资料" maxLength={256} required />
          </label>
          {isFixedPrice ? (
            <>
              <label htmlFor="seller-asking-amount">
                <span>报价{currency ? `（${currency}）` : ""}</span>
                <input id="seller-asking-amount" value={askingAmount} onChange={(event) => setAskingAmount(event.target.value)} inputMode="decimal" placeholder={amountPlaceholder(pricingScale ?? 0)} required />
              </label>
              <label htmlFor="seller-currency">
                <span>币种</span>
                <input id="seller-currency" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="等待子平台配置" maxLength={3} readOnly={Boolean(pricingCurrency)} required />
              </label>
            </>
          ) : null}
          {schemaFields.map((field) => (
            <label key={field.key} htmlFor={`seller-attribute-${field.key}`}>
              <span>{field.label}{field.required ? " *" : ""}</span>
              {field.type === "select" ? (
                <select id={`seller-attribute-${field.key}`} value={fieldValues[field.key] ?? ""} onChange={(event) => setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))}>
                  <option value="">请选择</option>
                  {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input id={`seller-attribute-${field.key}`} type={field.type ?? "text"} value={fieldValues[field.key] ?? ""} onChange={(event) => setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} required={field.required} />
              )}
            </label>
          ))}
          {customFields.map((field) => (
            <div className="seller-custom-field" key={field.id}>
              <input aria-label="自定义字段名" value={field.key} onChange={(event) => setCustomFields((current) => current.map((item) => item.id === field.id ? { ...item, key: event.target.value } : item))} placeholder="字段名" />
              <input aria-label="自定义字段值" value={field.value} onChange={(event) => setCustomFields((current) => current.map((item) => item.id === field.id ? { ...item, value: event.target.value } : item))} placeholder="字段值" />
              <button type="button" aria-label="删除自定义字段" onClick={() => setCustomFields((current) => current.filter((item) => item.id !== field.id))}><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          ))}
          <div className="seller-upload-wide seller-form-tools">
            <button className="text-action" type="button" onClick={() => setCustomFields((current) => [...current, { id: crypto.randomUUID(), key: "", value: "" }])}><Plus size={16} aria-hidden="true" /> 添加字段</button>
            <button className="text-action" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? "收起高级资料" : "使用高级 JSON"}</button>
          </div>
          {advancedOpen ? (
            <label className="seller-upload-wide" htmlFor="seller-attributes">
              <span>高级资料（JSON）</span>
              <textarea id="seller-attributes" value={advancedAttributes} onChange={(event) => setAdvancedAttributes(event.target.value)} rows={8} spellCheck={false} />
            </label>
          ) : null}
          <div className="seller-upload-actions seller-upload-wide">
            <p><FileUp size={17} aria-hidden="true" /> 提交后状态为“待审核”，平台不会自动发布未经确认的资料。</p>
            <motion.button className="button button-dark" type="submit" disabled={submitting || (isLiveMarketplaceEnabled() && (!subplatform.domainId || (isFixedPrice && (!subplatform.assetSchemaId || !pricingCurrency || !Number.isInteger(pricingScale)))))} whileTap={{ scale: 0.97 }} transition={spring}>
              {submitting ? "正在提交…" : "上传并提交审核"}
              {!submitting ? <ArrowRight size={18} aria-hidden="true" /> : null}
            </motion.button>
          </div>
        </form>
      </section>

      <section className="surface seller-submissions" aria-labelledby="seller-submissions-title">
        <SectionHeading eyebrow="提交记录" title="当前子平台的资料" />
        {submissionsLoading ? (
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>正在读取你的提交记录…</p></div>
        ) : submissionsError ? (
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>{submissionsError}</p><button type="button" onClick={() => void loadSubmissions()}>重新读取</button></div>
        ) : submissions.length ? (
          <ol className="submission-list">
            {submissions.map((submission) => (
              <li key={sellerRecordId(submission)}>
                <div><strong>{submission.display_name}</strong><small>{submission.external_key} · {sellerRecordPrice(submission, pricing)} · {formatSubmissionDate(submission.updated_at)}</small>{"review_reason" in submission && submission.review_reason ? <small className="submission-review-reason">{submission.review_reason}</small> : null}</div>
                <span className="submission-status">{submissionStatusLabel(submission.status)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>还没有上传记录。第一份资料由你定义。</p></div>
        )}
      </section>

      <section className="surface seller-submissions" aria-labelledby="seller-introductions-title">
        <SectionHeading eyebrow="联系申请" title="需要你明确同意，才会交换联系方式" />
        {introductionsError ? (
          <div className="seller-empty-state"><ShieldCheck size={24} aria-hidden="true" /><p>{introductionsError}</p></div>
        ) : introductions.length ? (
          <ol className="submission-list">
            {introductions.map((introduction) => (
              <li key={introduction.introduction_id}>
                <div>
                  <strong>一条撮合联系申请</strong>
                  <small>{introductionStatusLabel(introduction.status)} · {formatSubmissionDate(introduction.created_at)}</small>
                </div>
                {introduction.supply_contact_consent_at ? (
                  <span className="submission-status">已同意</span>
                ) : introduction.status === "contact_requested" ? (
                  <button className="text-action" type="button" onClick={() => void consent(introduction)} disabled={consentingIntroductionId === introduction.introduction_id}>
                    {consentingIntroductionId === introduction.introduction_id ? "处理中…" : "同意交换"}
                  </button>
                ) : (
                  <span className="submission-status">等待需求方确认</span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <div className="seller-empty-state"><ShieldCheck size={24} aria-hidden="true" /><p>暂无待处理的联系申请。</p></div>
        )}
      </section>
    </div>
  );
}

function amountPlaceholder(scale: number): string {
  return scale > 0 ? `例如 1000.${"0".repeat(Math.min(scale, 2))}` : "例如 1000";
}

function sellerRecordId(record: SellerRecord): string {
  return "submission_id" in record ? record.submission_id : record.offer_id;
}

function sellerRecordPrice(record: SellerRecord, pricing: { mode: string }): string {
  if ("asking_amount" in record) {
    return formatMinorUnits(record.asking_amount, record.currency, record.currency_scale);
  }
  const display = stringAttribute(record.terms, ["display_price", "price_label", "price"]);
  return display || (pricing.mode === "none" ? "—" : "待补充");
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

function formatSubmissionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleDateString("zh-CN");
}

function submissionStatusLabel(status: string): string {
  return {
    pending_review: "待审核",
    approved: "已通过",
    rejected: "需修改",
    withdrawn: "已撤回",
  }[status] ?? status;
}

function introductionStatusLabel(status: string): string {
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
