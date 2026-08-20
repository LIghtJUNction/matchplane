"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, Store } from "lucide-react";

import { createHostedStore, getOwnedStores, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function HostedStoreOnboarding({ locale, onNotice }: { locale: InterfaceLocale; onNotice: (message: string) => void }) {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void getOwnedStores().then((items) => { if (active) setStores(items); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const store = await createHostedStore({ name, slug, description });
      onNotice(locale === "en" ? "Store created. Opening your product console…" : "店铺已经创建，正在进入商品控制台…");
      window.location.assign(store.path);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : locale === "en" ? "Could not create the store." : "店铺创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="hosted-store-onboarding" aria-labelledby="hosted-store-title">
      <div className="hosted-store-heading">
        <span aria-hidden="true"><Store size={20} /></span>
        <div>
          <h2 id="hosted-store-title">{locale === "en" ? "Your stores" : "我的店铺"}</h2>
          <p>{locale === "en" ? "Open a hosted store, then add products from its console." : "创建一个托管店铺，然后直接在店铺控制台上架商品。"}</p>
        </div>
      </div>

      {stores.length ? (
        <ul className="owned-store-list">
          {stores.map((store) => (
            <li key={store.id}>
              <a href={store.path}>
                <span><strong>{store.displayName}</strong><small>{store.path}</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="hosted-store-form" onSubmit={submit}>
        <label htmlFor="hosted-store-name"><span>{locale === "en" ? "Store name" : "店铺名称"}</span><input id="hosted-store-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required /></label>
        <label htmlFor="hosted-store-slug"><span>{locale === "en" ? "Store address" : "店铺地址"}</span><div className="slug-input"><span>/</span><input id="hosted-store-slug" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} minLength={2} maxLength={63} pattern="[a-z0-9][a-z0-9-]+" placeholder="my-store" required /></div></label>
        <label className="hosted-store-wide" htmlFor="hosted-store-description"><span>{locale === "en" ? "Short description" : "店铺简介"}</span><textarea id="hosted-store-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} placeholder={locale === "en" ? "What do you sell?" : "简单介绍你出售的商品"} /></label>
        <button className="button button-dark hosted-store-wide" type="submit" disabled={submitting}>{submitting ? (locale === "en" ? "Creating…" : "正在创建…") : (locale === "en" ? "Create store" : "创建店铺")}<ArrowRight size={18} aria-hidden="true" /></button>
      </form>
    </section>
  );
}
