import { Button } from "@appica/ui-react/button";
import { Card, CardDescription } from "@appica/ui-react/card";
import { Input } from "@appica/ui-react/input";
import {
  AlertCircle,
  LoaderCircle,
  Package,
  RefreshCw,
  Save,
  Search,
  Star,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getStoreCustomers,
  updateStoreCustomer,
  type StoreCustomerRecord,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";

const STAGES: StoreCustomerRecord["stage"][] = [
  "new",
  "discovering",
  "qualified",
  "contact_requested",
  "contact_exchanged",
  "won",
  "lost",
];

export function StoreCustomersPanel({
  storeId,
  locale,
}: {
  storeId: string;
  locale: InterfaceLocale;
}) {
  const english = locale === "en";
  const [customers, setCustomers] = useState<StoreCustomerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [stageFilter, setStageFilter] = useState<"all" | StoreCustomerRecord["stage"]>("all");
  const [query, setQuery] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getStoreCustomers(storeId);
      setCustomers(next);
      setSelectedId((current) =>
        current && next.some((customer) => customer.id === current)
          ? current
          : null,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : english
            ? "Customer tracking is temporarily unavailable."
            : "客户跟进暂时不可用。",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [storeId]);

  const visibleCustomers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return customers.filter((customer) => {
      const matchesQuery = normalizedQuery
        ? [
            customer.displayName,
            customer.analysis,
            ...customer.products.map((product) => product.name),
          ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        : true;
      return (
        matchesQuery &&
        (!favoriteOnly || customer.favorite) &&
        (stageFilter === "all" || customer.stage === stageFilter)
      );
    });
  }, [customers, favoriteOnly, query, stageFilter]);
  const summary = useMemo(
    () => ({
      total: customers.length,
      favorites: customers.filter((customer) => customer.favorite).length,
      consented: customers.filter(
        (customer) => customer.contactConsentStatus === "accepted",
      ).length,
    }),
    [customers],
  );
  const selected =
    customers.find((customer) => customer.id === selectedId) ?? null;

  useEffect(() => {
    setNotesDraft(selected?.staffNotes ?? "");
  }, [selected?.id, selected?.staffNotes]);

  const patch = async (
    customer: StoreCustomerRecord,
    changes: {
      favorite?: boolean;
      stage?: StoreCustomerRecord["stage"];
      staffNotes?: string | null;
    },
  ) => {
    setUpdatingId(customer.id);
    setError(null);
    try {
      const updated = await updateStoreCustomer({
        storeId,
        customerId: customer.id,
        expectedVersion: customer.version,
        ...changes,
      });
      setCustomers((current) =>
        current.map((item) =>
          item.id === customer.id
            ? {
                ...item,
                ...updated,
                displayName: updated.displayName || item.displayName,
                avatarUrl: updated.avatarUrl ?? item.avatarUrl,
                products: updated.products.length ? updated.products : item.products,
              }
            : item,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : english
            ? "Customer update failed."
            : "客户记录更新失败。",
      );
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <section className="store-customers" aria-labelledby="store-customers-title">
      <div className="store-customers-heading">
        <div>
          <p>{english ? "CUSTOMER SIGNALS" : "客户信号"}</p>
          <h2 id="store-customers-title">
            {english ? "Customer management" : "客户管理"}
          </h2>
          <span>
            {english
              ? "AI-qualified intent, interested products, and follow-up state. Contact details remain consent-gated."
              : "查看 AI 识别的意向、关注商品和跟进阶段。联系方式仍受用户同意保护。"}
          </span>
        </div>
        <Button
          variant="outline"
          size="md"
          className="min-h-11"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {english ? "Refresh" : "刷新"}
        </Button>
      </div>

      <div className="store-customers-filters" aria-label={english ? "Customer filters" : "客户筛选"}>
        <label className="store-customers-search relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={16}
            aria-hidden="true"
          />
          <Input
            value={query}
            aria-label={english ? "Search customers" : "搜索客户"}
            placeholder={english ? "Search name, intent, or product" : "搜索姓名、意向或商品"}
            className="min-h-11 pl-9"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={favoriteOnly}
            onChange={(event) => setFavoriteOnly(event.target.checked)}
          />
          {english ? "Favorites" : "只看收藏"}
        </label>
        <label>
          <span>{english ? "Stage" : "阶段"}</span>
          <select
            value={stageFilter}
            onChange={(event) =>
              setStageFilter(event.target.value as typeof stageFilter)
            }
          >
            <option value="all">{english ? "All" : "全部"}</option>
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabel(stage, english)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className="store-customers-summary grid grid-cols-3 gap-2 sm:gap-3"
        role="group"
        aria-label={english ? "Customer summary" : "客户概览"}
      >
        <Card
          className="min-w-0"
          contentProps={{ className: "justify-between gap-1 sm:p-3" }}
        >
          <CardDescription>
            {english ? "Qualified customers" : "高意向客户"}
          </CardDescription>
          <p className="text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
            {summary.total}
          </p>
        </Card>
        <Card
          className="min-w-0"
          contentProps={{ className: "justify-between gap-1 sm:p-3" }}
        >
          <CardDescription>{english ? "Favorites" : "已收藏"}</CardDescription>
          <p className="text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
            {summary.favorites}
          </p>
        </Card>
        <Card
          className="min-w-0"
          contentProps={{ className: "justify-between gap-1 sm:p-3" }}
        >
          <CardDescription>
            {english ? "Contact consent" : "已同意联系"}
          </CardDescription>
          <p className="text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
            {summary.consented}
          </p>
        </Card>
      </div>

      {error ? (
        <div className="store-customers-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
          <Button
            variant="outline"
            size="md"
            className="min-h-11"
            type="button"
            onClick={() => void load()}
          >
            {english ? "Retry" : "重试"}
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="store-customers-state" role="status">
          <LoaderCircle className="is-spinning" size={22} aria-hidden="true" />
          {english ? "Loading customer signals…" : "正在读取客户信号…"}
        </div>
      ) : customers.length ? visibleCustomers.length ? (
        <div className="store-customers-layout">
          <ul className="store-customers-list" aria-label={english ? "Customers" : "客户列表"}>
            {visibleCustomers.map((customer) => (
              <li
                key={customer.id}
                className={selectedId === customer.id ? "is-selected" : ""}
              >
                <button
                  className="store-customer-row"
                  type="button"
                  onClick={() => setSelectedId(customer.id)}
                >
                  <span className="store-customer-avatar" aria-hidden="true">
                    {customer.avatarUrl ? (
                      <img src={customer.avatarUrl} alt="" />
                    ) : (
                      customer.displayName.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="store-customer-row-copy">
                    <strong>{customer.displayName}</strong>
                    <small>
                      {intentLabel(customer.intent, english)} · {stageLabel(customer.stage, english)}
                    </small>
                    <span>{customer.analysis || (english ? "Awaiting AI summary" : "等待 AI 生成摘要")}</span>
                  </span>
                </button>
                <button
                  className="store-customer-favorite"
                  type="button"
                  aria-label={
                    customer.favorite
                      ? english
                        ? "Remove from favorites"
                        : "取消收藏"
                      : english
                        ? "Add to favorites"
                        : "收藏客户"
                  }
                  aria-pressed={customer.favorite}
                  disabled={updatingId === customer.id}
                  onClick={() => void patch(customer, { favorite: !customer.favorite })}
                >
                  <Star size={16} fill={customer.favorite ? "currentColor" : "none"} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <article className="store-customer-detail" aria-label={selected.displayName}>
              <div className="store-customer-detail-heading">
                <div>
                  <p>{intentLabel(selected.intent, english)}</p>
                  <h3>{selected.displayName}</h3>
                  <span>{formatTime(selected.lastActivityAt, locale)}</span>
                </div>
                <label>
                  <span>{english ? "Stage" : "跟进阶段"}</span>
                  <select
                    value={selected.stage}
                    disabled={updatingId === selected.id}
                    onChange={(event) =>
                      void patch(selected, {
                        stage: event.target.value as StoreCustomerRecord["stage"],
                      })
                    }
                  >
                    {STAGES.map((stage) => (
                      <option key={stage} value={stage}>
                        {stageLabel(stage, english)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <section>
                <h4>{english ? "AI analysis" : "AI 意向分析"}</h4>
                <p>{selected.analysis || (english ? "No analysis yet." : "暂时没有分析。")}</p>
                <div className="store-customer-consent">
                  <span>{english ? "Contact consent" : "联系方式同意"}</span>
                  <strong>{consentLabel(selected.contactConsentStatus, english)}</strong>
                </div>
              </section>

              <section>
                <h4>{english ? "Interested products" : "关注商品"}</h4>
                {selected.products.length ? (
                  <ul className="store-customer-products">
                    {selected.products.map((product) => (
                      <li key={product.id}>
                        <span aria-hidden="true">
                          {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <Package size={18} />}
                        </span>
                        <div>
                          <strong>{product.name}</strong>
                          {product.price ? <small>{product.price}</small> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="store-customer-muted">
                    {english ? "No specific product recorded." : "本轮尚未关联具体商品。"}
                  </p>
                )}
              </section>

              <section>
                <label className="store-customer-notes">
                  <span>{english ? "Staff notes" : "店员备注"}</span>
                  <textarea
                    rows={4}
                    maxLength={2000}
                    value={notesDraft}
                    onChange={(event) => setNotesDraft(event.target.value)}
                    placeholder={english ? "Next action, timing, constraints…" : "下一步、时间、约束…"}
                  />
                </label>
                <Button
                  variant="primary"
                  size="md"
                  className="min-h-11"
                  type="button"
                  disabled={
                    updatingId === selected.id ||
                    notesDraft === (selected.staffNotes ?? "")
                  }
                  onClick={() => void patch(selected, { staffNotes: notesDraft })}
                >
                  <Save size={15} aria-hidden="true" />
                  {updatingId === selected.id
                    ? english
                      ? "Saving…"
                      : "保存中…"
                    : english
                      ? "Save notes"
                      : "保存备注"}
                </Button>
              </section>
            </article>
          ) : (
            <aside
              className="store-customers-state is-empty store-customer-detail-empty"
              aria-labelledby="store-customer-detail-empty-title"
            >
              <UserRound size={25} aria-hidden="true" />
              <h3 id="store-customer-detail-empty-title">
                {english ? "Select a customer" : "选择一位客户"}
              </h3>
              <p>
                {english
                  ? "Choose a customer to review intent, interested products, contact consent, and staff notes."
                  : "选择客户后，这里会显示意向分析、关注商品、联系方式同意状态和店员备注。"}
              </p>
            </aside>
          )}
        </div>
      ) : (
        <div className="store-customers-state is-empty">
          <strong>{english ? "No matching customers" : "没有符合筛选条件的客户"}</strong>
          <Button
            variant="ghost"
            size="md"
            className="min-h-11"
            type="button"
            onClick={() => {
              setFavoriteOnly(false);
              setStageFilter("all");
              setQuery("");
            }}
          >
            {english ? "Clear filters" : "清除筛选"}
          </Button>
        </div>
      ) : (
        <div className="store-customers-state is-empty">
          <UserRound size={25} aria-hidden="true" />
          <strong>{english ? "No qualified customers yet" : "暂时没有高意向客户"}</strong>
          <span>
            {english
              ? "When the AI manager detects purchase intent or requests staff help, the customer will appear here."
              : "AI 店长识别到购买意向或请求店员介入后，客户会出现在这里。"}
          </span>
        </div>
      )}
    </section>
  );
}

function intentLabel(intent: StoreCustomerRecord["intent"], english: boolean) {
  if (english) return intent === "urgent" ? "Urgent intent" : intent === "high" ? "High intent" : "Warm lead";
  return intent === "urgent" ? "紧急意向" : intent === "high" ? "高意向" : "潜在意向";
}

function stageLabel(stage: StoreCustomerRecord["stage"], english: boolean) {
  const labels = english
    ? {
        new: "New",
        discovering: "Discovering",
        qualified: "Qualified",
        contact_requested: "Contact requested",
        contact_exchanged: "Contact exchanged",
        won: "Won",
        lost: "Lost",
      }
    : {
        new: "新客户",
        discovering: "了解中",
        qualified: "已确认意向",
        contact_requested: "已申请联系",
        contact_exchanged: "已交换联系",
        won: "已成交",
        lost: "已流失",
      };
  return labels[stage];
}

function consentLabel(
  status: StoreCustomerRecord["contactConsentStatus"],
  english: boolean,
) {
  const labels = english
    ? {
        not_requested: "Not requested",
        pending: "Awaiting customer",
        accepted: "Accepted",
        declined: "Declined",
      }
    : {
        not_requested: "未请求",
        pending: "等待客户确认",
        accepted: "已同意",
        declined: "已拒绝",
      };
  return labels[status];
}

function formatTime(value: string, locale: InterfaceLocale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
