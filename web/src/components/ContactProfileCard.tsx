"use client";

import { FormEvent, useMemo, useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { motion } from "motion/react";

import { type ContactExchange } from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import { localizedSubplatformCopy } from "../lib/localized-copy";
import { type SubplatformConfig } from "../subplatform";
import { spring } from "./Primitives";

interface ContactProfileCardProps {
  locale: InterfaceLocale;
  subplatform: SubplatformConfig;
  role: "buyer" | "seller";
  onNotice: (message: string) => void;
}

/**
 * Contact values belong to the participant, not to a vehicle or another vertical record.
 * The server encrypts the map and only releases the counterpart after the consent transition.
 */
export function ContactProfileCard({ locale, subplatform, role, onNotice }: ContactProfileCardProps) {
  // The root platform supplies phone and WeChat defaults; mounted packages may replace them with
  // their own declared channels. Values still remain encrypted and consent-gated.
  const fields = useMemo(() => subplatform.ui?.contactFields ?? [], [subplatform.ui?.contactFields]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const copy = (key: string, fallbackZh: string, fallbackEn = fallbackZh) => localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const contact = Object.fromEntries(
      Object.entries(values)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value),
    ) as ContactExchange;
    const missing = fields.find((field) => field.required && !contact[field.key]);
    if (missing) {
      onNotice(locale === "en" ? `${missing.label} is required` : `${missing.label}不能为空`);
      return;
    }
    if (!Object.keys(contact).length) {
      onNotice(copy("contactProfileRequiredNotice", "至少填写一种联系方式", "Enter at least one contact channel"));
      return;
    }
    if (!subplatform.tenantId || !subplatform.domainId) {
      onNotice(copy("contactProfileScopeNotice", "当前平台尚未完成身份配置", "This platform has not finished its identity setup"));
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
      onNotice(copy("contactProfileSavedNotice", "已配置的联系方式已加密保存；双方同意后才会交换", "Your contact channels are encrypted; they are shared only after both sides agree"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("contactProfileSaveError", "联系方式保存失败，请稍后重试", "Could not save contact channels; try again"));
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
          <p className="eyebrow">{copy("contactProfileEyebrow", "联系方式", "Contact channels")}</p>
          <h2 id="contact-profile-title">{copy("contactProfileTitle", "设置双方同意后交换的渠道", "Choose the channels to exchange after both sides agree")}</h2>
          <p>{copy("contactProfileDescription", "填写当前平台配置的联系方式。平台只保存加密值，不会提前展示给对方。", "Enter the channels configured for this platform. Values are encrypted and never shown early.")}</p>
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
          <span>{copy("contactProfileSecurityLabel", "加密保存 · 双方同意后释放", "Encrypted · released after mutual consent")}</span>
          <motion.button className="button button-dark" type="submit" disabled={saving} whileTap={{ scale: 0.97 }} transition={spring}>
            {saving ? copy("contactProfileSavingLabel", "保存中…", "Saving…") : copy("contactProfileSaveLabel", "保存联系方式", "Save contact channels")}
            <ArrowRight size={17} aria-hidden="true" />
          </motion.button>
        </div>
      </form>
    </section>
  );
}
