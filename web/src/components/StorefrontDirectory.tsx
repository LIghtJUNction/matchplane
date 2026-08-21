"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Sparkles, Store } from "lucide-react";

import { getStores, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function StorefrontDirectory({ locale, mallName }: { locale: InterfaceLocale; mallName: string }) {
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

  return (
    <section className="storefront-directory" aria-labelledby="storefront-directory-title" aria-busy={!resolved}>
      <h2 id="storefront-directory-title" className="visually-hidden">{locale === "en" ? "Mall store map" : "商城店铺地图"}</h2>
      <div className="storefront-map">
        <div className="storefront-map-road road-horizontal" aria-hidden="true" />
        <div className="storefront-map-road road-vertical" aria-hidden="true" />
        <div className="storefront-map-hub">
          <span aria-hidden="true"><Sparkles size={18} /></span>
          <strong>{mallName}</strong>
          <small>{locale === "en" ? "AI shopping desk" : "AI 导购台"}</small>
        </div>
        {resolved && stores.length ? (
          <ul className="storefront-directory-list">
            {stores.map((store, index) => (
              <li key={store.id} data-map-slot={index % 6}>
                <a href={store.path}>
                  <span className="storefront-directory-icon" aria-hidden="true"><Store size={18} /></span>
                  <span>
                    <strong>{store.displayName}</strong>
                    <small>{store.description || (locale === "en" ? "Open store" : "营业中")}</small>
                  </span>
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        ) : resolved ? (
          <p className="storefront-map-empty">{locale === "en" ? "The first storefront is being prepared." : "第一家店铺正在筹备中。"}</p>
        ) : (
          <p className="storefront-map-empty">{locale === "en" ? "Loading the store map…" : "正在加载店铺地图…"}</p>
        )}
      </div>
    </section>
  );
}
