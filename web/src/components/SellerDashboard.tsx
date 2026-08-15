"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, FileUp, Gauge, ShieldCheck, Sparkles } from "lucide-react";
import { motion } from "motion/react";

import {
  isLiveMarketplaceEnabled,
  submitSellerListing,
  type ListingSubmission,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { SubplatformConfig } from "../subplatform";
import { MetricCard, SectionHeading, spring } from "./Primitives";

interface SellerDashboardProps {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}

/** Generic seller surface. The active subplatform owns the meaning of `attributes`. */
export function SellerDashboard({ onNotice, subplatform }: SellerDashboardProps) {
  const [externalKey, setExternalKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [askingAmount, setAskingAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [attributes, setAttributes] = useState("{}");
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<ListingSubmission[]>([]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = displayName.trim();
    const normalizedKey = externalKey.trim();
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!normalizedKey || !normalizedName || !askingAmount.trim() || !normalizedCurrency) {
      onNotice("请完整填写供给名称、内部编号、报价和币种");
      return;
    }
    let parsedAttributes: Record<string, unknown>;
    try {
      const parsed = JSON.parse(attributes || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not-object");
      parsedAttributes = parsed as Record<string, unknown>;
    } catch {
      onNotice("结构化资料必须是 JSON 对象，例如 {\"field\": \"value\"}");
      return;
    }

    const session = await getMarketplaceSession({
      subplatform: subplatform.slug,
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
            askingAmount: askingAmount.trim(),
            currency: normalizedCurrency,
            currencyScale: subplatform.currencyScale ?? 0,
          })
        : demoSubmission({
            session,
            externalKey: normalizedKey,
            displayName: normalizedName,
            attributes: parsedAttributes,
            askingAmount: askingAmount.trim(),
            currency: normalizedCurrency,
            currencyScale: subplatform.currencyScale ?? 0,
          });
      setSubmissions((current) => [submission, ...current]);
      setExternalKey("");
      setDisplayName("");
      setAskingAmount("");
      setCurrency("");
      setAttributes("{}");
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

      <section className="metric-grid" aria-label="供给方核心指标">
        <MetricCard icon={Sparkles} label="有效曝光" value="—" detail="等待实时数据" tone="cactus" />
        <MetricCard icon={FileUp} label="已提交资料" value={String(submissions.length)} detail="当前浏览会话" />
        <MetricCard icon={Gauge} label="高意向匹配" value="—" detail="审核通过后统计" tone="heather" />
        <MetricCard icon={ShieldCheck} label="已解锁联系" value="—" detail="双方同意后显示" tone="clay" />
      </section>

      <section className="surface seller-upload" aria-labelledby="seller-upload-title">
        <SectionHeading eyebrow="卖家上传" title="提交一份新的供给资料" />
        <p className="seller-upload-intro">
          字段由当前子平台的 schema 定义。根平台只保存结构化 JSON，不会替商家猜测或填充领域信息。
        </p>
        <form className="seller-upload-form" onSubmit={submit}>
          <label htmlFor="seller-display-name">
            <span>供给名称</span>
            <input id="seller-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="由你填写" maxLength={500} />
          </label>
          <label htmlFor="seller-external-key">
            <span>内部编号</span>
            <input id="seller-external-key" value={externalKey} onChange={(event) => setExternalKey(event.target.value)} placeholder="用于更新同一份资料" maxLength={256} />
          </label>
          <label htmlFor="seller-asking-amount">
            <span>报价（最小货币单位）</span>
            <input id="seller-asking-amount" value={askingAmount} onChange={(event) => setAskingAmount(event.target.value)} inputMode="numeric" placeholder="例如 100000" />
          </label>
          <label htmlFor="seller-currency">
            <span>币种</span>
            <input id="seller-currency" value={currency} onChange={(event) => setCurrency(event.target.value)} placeholder="ISO 4217，例如 CNY" maxLength={3} />
          </label>
          <label className="seller-upload-wide" htmlFor="seller-attributes">
            <span>结构化资料（JSON）</span>
            <textarea id="seller-attributes" value={attributes} onChange={(event) => setAttributes(event.target.value)} rows={8} spellCheck={false} />
          </label>
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
        <SectionHeading eyebrow="提交记录" title="本次会话的资料" />
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
