"use client";

import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { getStores, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function StorefrontDirectory({
  locale,
  home = false,
}: {
  locale: InterfaceLocale;
  home?: boolean;
}) {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let active = true;
    void getStores()
      .then((items) => {
        if (active) setStores(items);
      })
      .catch(() => {
        if (active) setStores([]);
      })
      .finally(() => {
        if (active) setResolved(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (home)
    return (
      <HomeStorefrontDirectory
        locale={locale}
        resolved={resolved}
        stores={stores}
      />
    );

  const featured = stores[0];
  const remaining = stores.slice(1);

  return (
    <section
      className="storefront-directory"
      aria-labelledby="storefront-directory-title"
      aria-busy={!resolved}
    >
      <div className="storefront-directory-heading">
        <div>
          <span>{locale === "en" ? "Marketplace" : "商城"}</span>
          <h2 id="storefront-directory-title">
            {locale === "en" ? "Stores" : "店铺"}
          </h2>
        </div>
        <small>
          {!resolved
            ? locale === "en"
              ? "Loading"
              : "读取中"
            : stores.length
              ? locale === "en"
                ? stores.length + " live"
                : stores.length + " 家已上线"
              : locale === "en"
                ? "No stores yet"
                : "暂无店铺"}
        </small>
      </div>

      {!resolved ? (
        <div className="storefront-directory-loading" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : featured ? (
        <div
          className={
            "storefront-card-stage" + (remaining.length ? "" : " is-single")
          }
        >
          <a className="storefront-featured-card" href={featured.path}>
            <div className="storefront-featured-top">
              <span className="storefront-card-mark" aria-hidden="true">
                {storeInitials(featured.displayName)}
              </span>
              <span>{storeKindLabel(featured.integrationKind, locale)}</span>
            </div>
            <div className="storefront-featured-copy">
              <strong>{featured.displayName}</strong>
              <p>
                {featured.description ||
                  (locale === "en"
                    ? "Open the store to browse its published products."
                    : "进入店铺浏览已经发布的商品。")}
              </p>
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
                    <span className="storefront-card-mark" aria-hidden="true">
                      {storeInitials(store.displayName)}
                    </span>
                    <span>
                      <strong>{store.displayName}</strong>
                      <small>
                        {store.description ||
                          storeKindLabel(store.integrationKind, locale)}
                      </small>
                    </span>
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="storefront-card-aside">
              <span>
                {locale === "en"
                  ? "More stores will appear here after approval."
                  : "更多店铺通过审核后会出现在这里。"}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="storefront-directory-empty">
          <span className="storefront-card-mark" aria-hidden="true">
            MP
          </span>
          <div>
            <strong>
              {locale === "en"
                ? "No stores are available yet."
                : "暂无可浏览店铺"}
            </strong>
            <p>
              {locale === "en"
                ? "Approved stores will appear here."
                : "店铺审核通过后会显示在这里。"}
            </p>
          </div>
        </div>
      )}

      <p className="storefront-directory-caption">
        {locale === "en" ? "Published products only" : "仅展示已发布商品"}
      </p>
    </section>
  );
}

function HomeStorefrontDirectory({
  locale,
  resolved,
  stores,
}: {
  locale: InterfaceLocale;
  resolved: boolean;
  stores: StoreSummary[];
}) {
  return (
    <section aria-labelledby="home-storefront-title" aria-busy={!resolved}>
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h2
            className="text-2xl font-semibold tracking-[-0.03em] text-foreground-intense"
            id="home-storefront-title"
          >
            {locale === "en" ? "Stores" : "店铺"}
          </h2>
        </div>
        {resolved && stores.length ? (
          <span className="text-sm text-foreground-muted">
            {locale === "en"
              ? `${stores.length} live`
              : `${stores.length} 家在营业`}
          </span>
        ) : null}
      </div>

      {!resolved ? (
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-hidden="true"
        >
          {[0, 1, 2].map((item) => (
            <div
              className="h-44 animate-pulse rounded-lg bg-background-muted motion-reduce:animate-none"
              key={item}
            />
          ))}
        </div>
      ) : stores.length ? (
        <div className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((store) => (
            <a
              className="group flex min-h-40 flex-col py-2 transition-transform duration-150 hover:-translate-y-0.5"
              href={store.path}
              key={store.id}
            >
              <div className="flex items-start justify-between gap-3">
                <span
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-background-muted text-xs font-semibold text-foreground-intense"
                  aria-hidden="true"
                >
                  {storeInitials(store.displayName)}
                </span>
                <ArrowUpRight
                  className="size-4 text-foreground-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  aria-hidden="true"
                />
              </div>
              <strong className="mt-5 line-clamp-2 text-base font-semibold text-foreground-intense">
                {store.displayName}
              </strong>
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-foreground-muted">
                {store.description ||
                  storeKindLabel(store.integrationKind, locale)}
              </p>
              <span className="mt-auto pt-4 text-xs font-medium text-foreground-strong">
                {locale === "en" ? "Enter store" : "进入店铺"}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="py-10 text-sm text-foreground-muted">
          {locale === "en"
            ? "No stores are open yet."
            : "暂时还没有营业中的店铺。"}
        </div>
      )}
    </section>
  );
}

function storeInitials(value: string): string {
  return [...value.trim()].slice(0, 2).join("").toUpperCase() || "MP";
}

function storeKindLabel(
  kind: StoreSummary["integrationKind"],
  locale: InterfaceLocale,
): string {
  if (locale === "en") {
    return kind === "hosted"
      ? "Hosted store"
      : kind === "external"
        ? "Connected store"
        : "Store package";
  }
  return kind === "hosted"
    ? "平台店铺"
    : kind === "external"
      ? "外部接入"
      : "店铺应用";
}
