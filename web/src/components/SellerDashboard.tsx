"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowRight, FileUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { motion } from "motion/react";

import {
  isLiveMarketplaceEnabled,
  submitSellerListing,
  type ListingSubmission,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { SubplatformConfig } from "../subplatform";
import { SectionHeading, spring } from "./Primitives";

interface SellerDashboardProps {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}

/** Generic seller surface. The active subplatform owns the meaning of `attributes`. */
export function SellerDashboard({ onNotice, subplatform }: SellerDashboardProps) {
  const [externalKey, setExternalKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [askingAmount, setAskingAmount] = useState("");
  const [currency, setCurrency] = useState(subplatform.currency ?? "");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<Array<{ id: string; key: string; value: string }>>([]);
  const [advancedAttributes, setAdvancedAttributes] = useState("{}");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<ListingSubmission[]>(() => readSubmissions(`matchplane.submissions.${subplatform.path}`));
  const submissionsKey = `matchplane.submissions.${subplatform.path}`;

  useEffect(() => {
    window.localStorage.setItem(submissionsKey, JSON.stringify(submissions));
  }, [submissions, submissionsKey]);

  useEffect(() => {
    setCurrency(subplatform.currency ?? "");
  }, [subplatform.currency]);

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
    const normalizedAmount = toMinorUnits(askingAmount, subplatform.currencyScale ?? 0);
    if (!normalizedKey || !normalizedName || !normalizedAmount || !normalizedCurrency) {
      onNotice("请完整填写名称、编号、报价和结算币种");
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

    const session = await getMarketplaceSession({
      subplatform: subplatform.slug,
      platformPath: subplatform.path,
      tenantId: subplatform.tenantId,
      domainId: subplatform.domainId,
      role: "seller",
    });
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?role=seller&next=${encodeURIComponent(next)}`);
      return;
    }
    if (isLiveMarketplaceEnabled() && (!subplatform.domainId || !subplatform.assetSchemaId)) {
      onNotice("当前子平台还没有配置 domain 或资料 schema，暂时不能提交真实供给");
      return;
    }

    setSubmitting(true);
    try {
      const submission = isLiveMarketplaceEnabled()
        ? await submitSellerListing({
            session,
            domainId: subplatform.domainId!,
            assetSchemaId: subplatform.assetSchemaId!,
            externalKey: normalizedKey,
            displayName: normalizedName,
            attributes: parsedAttributes,
            askingAmount: normalizedAmount,
            currency: normalizedCurrency,
            currencyScale: subplatform.currencyScale ?? 0,
          })
        : demoSubmission({
            session,
            externalKey: normalizedKey,
            displayName: normalizedName,
            attributes: parsedAttributes,
            askingAmount: normalizedAmount,
            currency: normalizedCurrency,
            currencyScale: subplatform.currencyScale ?? 0,
          });
      setSubmissions((current) => [submission, ...current]);
      setExternalKey("");
      setDisplayName("");
      setAskingAmount("");
      setCurrency(subplatform.currency ?? "");
      setFieldValues({});
      setCustomFields([]);
      setAdvancedAttributes("{}");
      setAdvancedOpen(false);
      onNotice(isLiveMarketplaceEnabled() ? "供给已提交，等待平台审核后展示" : "供给资料已记录（演示模式）");
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
          <label htmlFor="seller-asking-amount">
            <span>报价{currency ? `（${currency}）` : ""}</span>
            <input id="seller-asking-amount" value={askingAmount} onChange={(event) => setAskingAmount(event.target.value)} inputMode="decimal" placeholder={amountPlaceholder(subplatform.currencyScale ?? 0)} required />
          </label>
          <label htmlFor="seller-currency">
            <span>币种</span>
            <input id="seller-currency" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="由子平台配置" maxLength={3} readOnly={Boolean(subplatform.currency)} required />
          </label>
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
            <motion.button className="button button-dark" type="submit" disabled={submitting} whileTap={{ scale: 0.97 }} transition={spring}>
              {submitting ? "正在提交…" : "上传并提交审核"}
              {!submitting ? <ArrowRight size={18} aria-hidden="true" /> : null}
            </motion.button>
          </div>
        </form>
      </section>

      <section className="surface seller-submissions" aria-labelledby="seller-submissions-title">
        <SectionHeading eyebrow="提交记录" title="本设备最近的资料" />
        {submissions.length ? (
          <ol className="submission-list">
            {submissions.map((submission) => (
              <li key={submission.submission_id}>
                <div><strong>{submission.display_name}</strong><small>{submission.external_key} · {submission.currency} {submission.asking_amount}</small></div>
                <span className="submission-status">{submission.status === "pending_review" ? "待审核" : submission.status}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="seller-empty-state"><FileUp size={24} aria-hidden="true" /><p>还没有上传记录。第一份资料由你定义。</p></div>
        )}
      </section>
    </div>
  );
}

function demoSubmission(input: {
  session: { tenantId: string; partyId: string };
  externalKey: string;
  displayName: string;
  attributes: Record<string, unknown>;
  askingAmount: string;
  currency: string;
  currencyScale: number;
}): ListingSubmission {
  const now = new Date().toISOString();
  return {
    submission_id: crypto.randomUUID(),
    tenant_id: input.session.tenantId,
    domain_id: crypto.randomUUID(),
    seller_party_id: input.session.partyId,
    asset_schema_id: crypto.randomUUID(),
    external_key: input.externalKey,
    display_name: input.displayName,
    attributes: input.attributes,
    asking_amount: input.askingAmount,
    currency: input.currency,
    currency_scale: input.currencyScale,
    status: "pending_review",
    reviewed_by: null,
    review_reason: null,
    version: 1,
    created_at: now,
    updated_at: now,
  };
}

function amountPlaceholder(scale: number): string {
  return scale > 0 ? `例如 1000.${"0".repeat(Math.min(scale, 2))}` : "例如 1000";
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

function readSubmissions(key: string): ListingSubmission[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((item): item is ListingSubmission => Boolean(item) && typeof item === "object") : [];
  } catch {
    return [];
  }
}
