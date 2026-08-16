"use client";

import { FormEvent, useMemo, useState } from "react";
import { ArrowRight, LockKeyhole, Phone, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";

import { type ContactExchange } from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { subplatformCopy, type SubplatformConfig } from "../subplatform";
import { spring } from "./Primitives";

interface ContactProfileCardProps {
  subplatform: SubplatformConfig;
  role: "buyer" | "seller";
  onNotice: (message: string) => void;
}

/**
 * Contact values belong to the participant, not to a vehicle or another vertical record.
 * The server encrypts the map and only releases the counterpart after the consent transition.
 */
export function ContactProfileCard({ subplatform, role, onNotice }: ContactProfileCardProps) {
  // Contact channel names are platform-owned configuration. The kernel deliberately does not
  // invent phone/WeChat/QQ fields for a new vertical; a root operator or mounted package must
  // declare the fields in its manifest/configuration before the form is shown.
  const fields = useMemo(() => subplatform.ui?.contactFields ?? [], [subplatform.ui?.contactFields]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const contact = Object.fromEntries(
      Object.entries(values)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value),
    ) as ContactExchange;
    const missing = fields.find((field) => field.required && !contact[field.key]);
    if (missing) {
      onNotice(`${missing.label}不能为空`);
      return;
    }
    if (!Object.keys(contact).length) {
      onNotice(subplatformCopy(subplatform, "contactProfileRequiredNotice", "至少填写一种联系方式"));
      return;
    }
    if (!subplatform.tenantId || !subplatform.domainId) {
      onNotice(subplatformCopy(subplatform, "contactProfileScopeNotice", "当前平台尚未完成身份配置"));
      return;
    }
    setSaving(true);
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role,
        forceRefresh: true,
        contact,
        preserveContact: false,
      });
      if (!session) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?role=${role}&next=${encodeURIComponent(next)}`);
        return;
      }
      setValues({});
      onNotice(subplatformCopy(subplatform, "contactProfileSavedNotice", "联系方式已加密保存；双方同意后才会交换"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : subplatformCopy(subplatform, "contactProfileSaveError", "联系方式保存失败，请稍后重试"));
    } finally {
      setSaving(false);
    }
  };

  if (!fields.length) return null;

  return (
    <section className="surface contact-profile-card" aria-labelledby="contact-profile-title">
      <div className="contact-profile-heading">
        <span className="contact-profile-icon"><LockKeyhole size={17} aria-hidden="true" /></span>
        <div>
          <p className="eyebrow">{subplatformCopy(subplatform, "contactProfileEyebrow", "联系方式")}</p>
          <h2 id="contact-profile-title">{subplatformCopy(subplatform, "contactProfileTitle", "设置双方同意后交换的渠道")}</h2>
          <p>{subplatformCopy(subplatform, "contactProfileDescription", "可填写电话、微信、QQ、邮箱或当前子平台配置的其他渠道。平台只保存加密值，不会提前展示给对方。")}</p>
        </div>
      </div>
      <form className="contact-profile-form" onSubmit={save}>
        {fields.map((field) => (
          <label key={field.key} htmlFor={`contact-profile-${field.key}`}>
            <span>{field.label}{field.required ? " *" : ""}</span>
            <input
              id={`contact-profile-${field.key}`}
              type={field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text"}
              value={values[field.key] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              placeholder={field.placeholder}
              maxLength={256}
              autoComplete={field.type === "email" ? "email" : field.type === "tel" ? "tel" : "off"}
            />
          </label>
        ))}
        <div className="contact-profile-footer">
          <span><ShieldCheck size={15} aria-hidden="true" />{subplatformCopy(subplatform, "contactProfileSecurityLabel", "加密保存 · 双方同意后释放")}</span>
          <motion.button className="button button-dark" type="submit" disabled={saving} whileTap={{ scale: 0.97 }} transition={spring}>
            {saving ? subplatformCopy(subplatform, "contactProfileSavingLabel", "保存中…") : subplatformCopy(subplatform, "contactProfileSaveLabel", "保存联系方式")}
            {!saving ? <ArrowRight size={17} aria-hidden="true" /> : <Phone size={16} aria-hidden="true" />}
          </motion.button>
        </div>
      </form>
    </section>
  );
}
