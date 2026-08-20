"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Save } from "lucide-react";

import { getManagedStores, saveStoreCommercialTerms, type StoreSummary } from "../api";

type PricingModel = NonNullable<StoreSummary["commercialTerms"]>["pricingModel"];

export function StoreCommercialTermsPanel({ rootRole, onNotice }: { rootRole?: string | null; onNotice: (message: string) => void }) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [storeId, setStoreId] = useState("");
  const [pricingModel, setPricingModel] = useState<PricingModel>("none");
  const [recurringFee, setRecurringFee] = useState("");
  const [billingInterval, setBillingInterval] = useState<"month" | "year">("month");
  const [commissionPercent, setCommissionPercent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getManagedStores()
      .then((items) => {
        if (!active) return;
        setStores(items);
        setStoreId((current) => current || items[0]?.id || "");
      })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "店铺计费读取失败"); });
    return () => { active = false; };
  }, [onNotice]);

  const selected = useMemo(() => stores.find((store) => store.id === storeId) ?? null, [storeId, stores]);
  useEffect(() => {
    const terms = selected?.commercialTerms;
    if (!terms) return;
    setPricingModel(terms.pricingModel);
    setRecurringFee(fromMinor(terms.recurringFeeMinor));
    setBillingInterval(terms.billingInterval ?? "month");
    setCommissionPercent(terms.commissionBps ? String(terms.commissionBps / 100) : "");
  }, [selected]);

  const save = async () => {
    if (!canEdit || !selected?.commercialTerms || saving) return;
    const recurringFeeMinor = pricingModel === "subscription" || pricingModel === "hybrid" ? toMinor(recurringFee) : "0";
    const commissionBps = pricingModel === "commission" || pricingModel === "hybrid" ? toBasisPoints(commissionPercent) : 0;
    if (recurringFeeMinor === null || commissionBps === null) {
      onNotice("请填写有效的固定租金与成交服务费");
      return;
    }
    setSaving(true);
    try {
      const terms = await saveStoreCommercialTerms({
        storeId: selected.id,
        pricingModel,
        recurringFeeMinor,
        currency: "CNY",
        billingInterval: pricingModel === "subscription" || pricingModel === "hybrid" ? billingInterval : null,
        commissionBps,
        status: "draft",
        expectedVersion: selected.commercialTerms.version,
      });
      setStores((current) => current.map((store) => store.id === selected.id ? { ...store, commercialTerms: terms } : store));
      onNotice(pricingModel === "none" ? "这家店铺保持免计费" : "店铺计费草稿已保存；接入账单执行前不会自动扣费");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "店铺计费保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="store-commercial-terms" aria-labelledby="store-commercial-terms-title">
      <div className="store-commercial-terms-heading">
        <span aria-hidden="true"><Building2 size={18} /></span>
        <div>
          <h3 id="store-commercial-terms-title">店铺计费</h3>
          <p>先拟定固定租金、成交服务费或组合方案。当前仅保存草稿，不会自动扣费。</p>
        </div>
      </div>
      {stores.length ? (
        <div className="store-commercial-terms-form">
          <label><span>店铺</span><select value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.displayName}</option>)}</select></label>
          <label><span>计费方式</span><select value={pricingModel} disabled={!canEdit} onChange={(event) => setPricingModel(event.target.value as PricingModel)}><option value="none">免费入驻</option><option value="subscription">固定租金</option><option value="commission">成交服务费</option><option value="hybrid">固定租金 + 成交服务费</option></select></label>
          {pricingModel === "subscription" || pricingModel === "hybrid" ? <label><span>固定租金（CNY）</span><input value={recurringFee} disabled={!canEdit} onChange={(event) => setRecurringFee(event.target.value)} inputMode="decimal" placeholder="例如 299.00" /></label> : null}
          {pricingModel === "subscription" || pricingModel === "hybrid" ? <label><span>计费周期</span><select value={billingInterval} disabled={!canEdit} onChange={(event) => setBillingInterval(event.target.value as "month" | "year")}><option value="month">每月</option><option value="year">每年</option></select></label> : null}
          {pricingModel === "commission" || pricingModel === "hybrid" ? <label><span>成交服务费（%）</span><input value={commissionPercent} disabled={!canEdit} onChange={(event) => setCommissionPercent(event.target.value)} inputMode="decimal" placeholder="例如 2.5" /></label> : null}
          {canEdit ? <button type="button" disabled={saving} onClick={() => void save()}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存计费规则"}</button> : <p>商城运营可以查看；计费规则由商城负责人修改。</p>}
        </div>
      ) : <p className="store-commercial-terms-empty">还没有可配置计费的店铺。</p>}
    </section>
  );
}

function toMinor(value: string): string | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]{0,33})(?:\.[0-9]{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const minor = `${whole}${fraction.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(minor) > 0n ? minor : null;
}

function fromMinor(value: string): string {
  if (!/^[0-9]+$/.test(value)) return "";
  const padded = value.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function toBasisPoints(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null;
  return Math.round(parsed * 100);
}
