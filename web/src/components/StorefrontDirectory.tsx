"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, MessageSquareMore, Store } from "lucide-react";

import { getStores, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function StorefrontDirectory({
  locale,
  onDescribeNeed,
  onVisibleStorePathsChange,
}: {
  locale: InterfaceLocale;
  onDescribeNeed?: (platformPath: string) => void;
  onVisibleStorePathsChange?: (paths: readonly string[]) => void;
}) {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [resolved, setResolved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void getStores()
      .then((items) => {
        if (active) {
          setStores(items);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setStores([]);
          setFailed(true);
        }
      })
      .finally(() => {
        if (active) setResolved(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const paths =
      resolved && !failed
        ? Array.from(new Set(stores.map((store) => store.path)))
        : [];
    onVisibleStorePathsChange?.(paths);
    return () => onVisibleStorePathsChange?.([]);
  }, [failed, onVisibleStorePathsChange, resolved, stores]);

  return (
    <section
      className="storefront-directory"
      aria-labelledby="home-storefront-title"
      aria-busy={!resolved}
    >
      <div className="storefront-directory-heading">
        <h2 id="home-storefront-title">
          {locale === "en" ? "Stores" : "店铺"}
        </h2>
        {resolved && stores.length ? (
          <span className="storefront-directory-count">
            {locale === "en"
              ? `${stores.length} live`
              : `${stores.length} 家在营业`}
          </span>
        ) : null}
      </div>

      {resolved ? (
        stores.length ? (
          <ul
            className="storefront-directory-grid"
            data-store-count={stores.length > 4 ? "many" : stores.length}
            aria-labelledby="home-storefront-title"
          >
            {stores.map((store) => (
              <li className="storefront-directory-item" key={store.id}>
                <article className="storefront-directory-card">
                  <a className="storefront-directory-link" href={store.path}>
                    <span
                      className="storefront-directory-icon"
                      aria-hidden="true"
                    >
                      <Store />
                    </span>
                    <span className="storefront-directory-copy">
                      <strong>{store.displayName}</strong>
                      <span className="storefront-directory-description">
                        {store.description ||
                          (locale === "en"
                            ? "Browse published products in this store."
                            : "进入店铺浏览已发布商品。")}
                      </span>
                      <span className="storefront-directory-meta">
                        {store.status === "active" ? (
                          <span className="storefront-directory-live">
                            {locale === "en" ? "Open" : "营业中"}
                          </span>
                        ) : null}
                        <span className="storefront-directory-entry">
                          {locale === "en" ? "Enter store" : "进入店铺"}
                          <ArrowUpRight aria-hidden="true" />
                        </span>
                      </span>
                    </span>
                  </a>
                  {onDescribeNeed ? (
                    <button
                      className="storefront-demand-action"
                      type="button"
                      onClick={() => onDescribeNeed(store.path)}
                    >
                      <MessageSquareMore aria-hidden="true" />
                      {locale === "en" ? "Describe a need" : "说需求"}
                    </button>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        ) : failed ? (
          <div
            className="storefront-directory-status py-10 text-sm text-foreground-muted"
            role="alert"
          >
            {locale === "en"
              ? "Store directory is temporarily unavailable. Please try again later."
              : "店铺目录暂时不可用，请稍后再试。"}
          </div>
        ) : (
          <div
            className="storefront-directory-status py-10 text-sm text-foreground-muted"
            aria-live="polite"
          >
            {locale === "en"
              ? "No stores are open yet."
              : "暂时还没有营业中的店铺。"}
          </div>
        )
      ) : (
        <div
          className="storefront-directory-loading grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-hidden="true"
        >
          {[0, 1, 2].map((item) => (
            <div
              className="h-44 animate-pulse rounded-lg bg-background-muted motion-reduce:animate-none"
              key={item}
            />
          ))}
        </div>
      )}
    </section>
  );
}
