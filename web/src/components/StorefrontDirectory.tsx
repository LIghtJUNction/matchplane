"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, MessageSquareMore } from "lucide-react";

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
      <div className="storefront-directory-heading mb-8 flex items-end justify-between gap-4">
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

      {resolved ? (
        stores.length ? (
          <div className="storefront-directory-grid grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {stores.map((store) => (
              <article
                className="storefront-directory-card group flex min-h-40 flex-col py-2 transition-transform duration-150 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:transform-none"
                key={store.id}
              >
                <a
                  className="storefront-directory-link flex flex-1 flex-col"
                  href={store.path}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span
                      className="grid size-10 shrink-0 place-items-center rounded-full bg-background-muted text-xs font-semibold text-foreground-intense"
                      aria-hidden="true"
                    >
                      {storeInitials(store.displayName)}
                    </span>
                    <ArrowUpRight
                      className="size-4 text-foreground-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </div>
                  <strong className="mt-5 line-clamp-2 text-base font-semibold text-foreground-intense">
                    {store.displayName}
                  </strong>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-foreground-muted">
                    {store.description ||
                      (locale === "en"
                        ? "Browse published products in this store."
                        : "进入店铺浏览已发布商品。")}
                  </p>
                  <span className="mt-auto pt-4 text-xs font-medium text-foreground-strong">
                    {locale === "en" ? "Enter store" : "进入店铺"}
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
            ))}
          </div>
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

function storeInitials(value: string): string {
  return [...value.trim()].slice(0, 2).join("").toUpperCase() || "MP";
}
