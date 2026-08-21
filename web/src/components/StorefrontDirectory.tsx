"use client";

import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { getStores, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function StorefrontDirectory({ locale }: { locale: InterfaceLocale }) {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let active = true;
    void getStores()
      .then((items) => { if (active) setStores(items); })
      .catch(() => { if (active) setStores([]); })
      .finally(() => { if (active) setResolved(true); });
    return () => { active = false; };
  }, []);

  const featured = stores[0];
  const remaining = stores.slice(1);

  return (
    <section className="storefront-directory" aria-labelledby="storefront-directory-title" aria-busy={!resolved}>
      <div className="storefront-directory-heading">
        <div>
          <span>{locale === "en" ? "Marketplace" : "商城"}</span>
          <h2 id="storefront-directory-title">{locale === "en" ? "All products" : "全部商品"}</h2>
        </div>
        <small>{!resolved
          ? (locale === "en" ? "Loading" : "读取中")
          : stores.length
            ? (locale === "en" ? stores.length + " live" : stores.length + " 家已上线")
            : (locale === "en" ? "No products yet" : "暂无商品")}</small>
      </div>

      {!resolved ? (
        <div className="storefront-directory-loading" aria-hidden="true">
          <span /><span /><span />
        </div>
      ) : featured ? (
        <div className={"storefront-card-stage" + (remaining.length ? "" : " is-single")}>
          <a className="storefront-featured-card" href={featured.path}>
            <div className="storefront-featured-top">
              <span className="storefront-card-mark" aria-hidden="true">{storeInitials(featured.displayName)}</span>
              <span>{storeKindLabel(featured.integrationKind, locale)}</span>
            </div>
            <div className="storefront-featured-copy">
              <strong>{featured.displayName}</strong>
              <p>{featured.description || (locale === "en" ? "Open the store to browse its published products." : "进入店铺浏览已经发布的商品。")}</p>
            </div>
            <span className="storefront-card-action">
              {locale === "en" ? "Browse store" : "进店逛逛"}
              <ArrowRight size={18} aria-hidden="true" />
            </span>
          </a>

          {remaining.length ? (
            <ul className="storefront-compact-list">
              {remaining.map((store) => (
                <li key={store.id}>
                  <a href={store.path}>
                    <span className="storefront-card-mark" aria-hidden="true">{storeInitials(store.displayName)}</span>
                    <span>
                      <strong>{store.displayName}</strong>
                      <small>{store.description || storeKindLabel(store.integrationKind, locale)}</small>
                    </span>
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="storefront-card-aside">
              <span>{locale === "en" ? "More stores will appear here after approval." : "更多店铺通过审核后会出现在这里。"}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="storefront-directory-empty">
          <span className="storefront-card-mark" aria-hidden="true">MP</span>
          <div>
            <strong>{locale === "en" ? "No products are listed yet." : "暂无上架商品"}</strong>
            <p>{locale === "en" ? "Published products will appear here." : "商品发布并审核通过后会显示在这里。"}</p>
          </div>
        </div>
      )}

      <p className="storefront-directory-caption">
        {locale === "en" ? "Published products only" : "仅展示已发布商品"}
      </p>
    </section>
  );
}

function storeInitials(value: string): string {
  return [...value.trim()].slice(0, 2).join("").toUpperCase() || "MP";
}

function storeKindLabel(kind: StoreSummary["integrationKind"], locale: InterfaceLocale): string {
  if (locale === "en") {
    return kind === "hosted" ? "Hosted store" : kind === "external" ? "Connected store" : "Store package";
  }
  return kind === "hosted" ? "平台店铺" : kind === "external" ? "外部接入" : "店铺应用";
}
