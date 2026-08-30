"use client";

import { Button } from "@appica/ui-react/button";
import { ArrowRight, ChevronDown, Search, Store } from "lucide-react";
import { useId, useState } from "react";

import type { MallAssistantSearchTrace } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

function visibleResultLabel(locale: InterfaceLocale, count: number): string {
  if (locale === "zh") return `${count} 个可见结果`;
  return `${count} visible ${count === 1 ? "match" : "matches"}`;
}

function resultStoreLabel(locale: InterfaceLocale, count: number): string {
  if (locale === "zh") return `${count} 家店铺`;
  return `${count} ${count === 1 ? "store" : "stores"}`;
}

function traceIdentity(trace: MallAssistantSearchTrace): string {
  return JSON.stringify([
    trace.source,
    trace.resultCount,
    trace.stores.map(({ path, displayName, offerCount }) => [
      path,
      displayName,
      offerCount,
    ]),
  ]);
}

export function MarketplaceSearchTrace({
  trace,
  locale,
  onOpenStore,
}: {
  trace: MallAssistantSearchTrace;
  locale: InterfaceLocale;
  onOpenStore: (path: string) => void;
}) {
  const isEnglish = locale === "en";
  const detailsId = useId();
  const currentTraceIdentity = traceIdentity(trace);
  const [disclosure, setDisclosure] = useState({
    traceIdentity: currentTraceIdentity,
    expanded: false,
  });
  const expanded =
    disclosure.traceIdentity === currentTraceIdentity && disclosure.expanded;
  const resultSummary = isEnglish
    ? `${visibleResultLabel(locale, trace.resultCount)} from ${resultStoreLabel(locale, trace.stores.length)}`
    : `${resultStoreLabel(locale, trace.stores.length)}返回 ${visibleResultLabel(locale, trace.resultCount)}`;

  return (
    <section
      className="marketplace-search-trace"
      aria-labelledby="marketplace-search-trace-title"
      aria-live="polite"
    >
      <header className="marketplace-search-trace-heading">
        <h2 id="marketplace-search-trace-title">
          {isEnglish ? "Where these results came from" : "这些结果来自哪里"}
        </h2>
        <Button
          className="marketplace-search-trace-toggle"
          variant="outline"
          size="md"
          type="button"
          aria-controls={detailsId}
          aria-expanded={expanded}
          onClick={() =>
            setDisclosure({
              traceIdentity: currentTraceIdentity,
              expanded: !expanded,
            })
          }
        >
          {expanded
            ? isEnglish
              ? "Collapse search path"
              : "收起检索路径"
            : isEnglish
              ? "View search path"
              : "查看检索路径"}
          <ChevronDown aria-hidden="true" />
        </Button>
      </header>

      <div
        className="marketplace-search-trace-summary"
        aria-label={isEnglish ? "Search provenance summary" : "检索来源概览"}
      >
        <p className="marketplace-search-trace-summary-path">
          <span>{isEnglish ? "Your request" : "你的需求"}</span>
          <ArrowRight aria-hidden="true" />
          <strong>MatchPlane</strong>
          <ArrowRight aria-hidden="true" />
          <span>{resultStoreLabel(locale, trace.stores.length)}</span>
        </p>
        <small>{resultSummary}</small>
      </div>

      <ol
        className="marketplace-search-trace-flow"
        id={detailsId}
        hidden={!expanded}
      >
          <li className="marketplace-search-trace-step is-origin">
            <span className="marketplace-search-trace-index" aria-hidden="true">
              01
            </span>
            <strong>{isEnglish ? "Your request" : "你的需求"}</strong>
            <small>{isEnglish ? "Kept in context" : "保留原始语境"}</small>
          </li>
          <li className="marketplace-search-trace-connector" aria-hidden="true">
            <ArrowRight />
          </li>
          <li className="marketplace-search-trace-step is-plane">
            <span className="marketplace-search-trace-mark" aria-hidden="true">
              <Search />
            </span>
            <strong>MatchPlane</strong>
            <small>{isEnglish ? "Public catalog search" : "检索公开商品"}</small>
          </li>
          <li className="marketplace-search-trace-connector" aria-hidden="true">
            <ArrowRight />
          </li>
          <li className="marketplace-search-trace-destinations">
            <span className="sr-only">
              {isEnglish ? "Result stores" : "结果店铺"}
            </span>
            <ul>
              {trace.stores.map((store) => (
                <li key={store.path}>
                  <button
                    type="button"
                    className="marketplace-search-trace-store"
                    onClick={() => onOpenStore(store.path)}
                    aria-label={
                      isEnglish
                        ? `Open ${store.displayName}, ${visibleResultLabel(locale, store.offerCount)}`
                        : `进入${store.displayName}，${visibleResultLabel(locale, store.offerCount)}`
                    }
                  >
                    <span
                      className="marketplace-search-trace-store-icon"
                      aria-hidden="true"
                    >
                      <Store />
                    </span>
                    <span>
                      <strong>{store.displayName}</strong>
                      <small>
                        {visibleResultLabel(locale, store.offerCount)}
                      </small>
                    </span>
                    <ArrowRight
                      className="marketplace-search-trace-store-arrow"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </li>
      </ol>
    </section>
  );
}
