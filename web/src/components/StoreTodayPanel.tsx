"use client";

import { Button } from "@appica/ui-react/button";
import { ArrowRight, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  getMarketplaceOffers,
  getStoreCustomers,
  type MarketplaceOffer,
  type StoreCustomerRecord,
  type StoreSummary,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";

const DAY_MS = 24 * 60 * 60 * 1_000;
const VISIBLE_QUEUE_ITEMS = 4;
const TERMINAL_STAGES = new Set<StoreCustomerRecord["stage"]>([
  "won",
  "lost",
]);

interface ResourceState<T> {
  data: T;
  loaded: boolean;
  error: string | null;
}

interface StoreTodayPanelProps {
  locale: InterfaceLocale;
  store: StoreSummary;
  subplatform: SubplatformConfig;
  onOpenCustomers: (customerId?: string) => void;
  onOpenProducts: (offerId?: string) => void;
}

interface TodayQueues {
  newCustomers: StoreCustomerRecord[];
  contactCustomers: StoreCustomerRecord[];
  staleHighIntentCustomers: StoreCustomerRecord[];
  todayNextActionCustomers: StoreCustomerRecord[];
  staleOffers: MarketplaceOffer[];
}

type PrimaryTask =
  | { kind: "customer"; id: string; name: string; detail: string }
  | { kind: "offer"; id: string; name: string; detail: string };

const emptyCustomersState: ResourceState<StoreCustomerRecord[]> = {
  data: [],
  loaded: false,
  error: null,
};
const emptyOffersState: ResourceState<MarketplaceOffer[]> = {
  data: [],
  loaded: false,
  error: null,
};

export function StoreTodayPanel({
  locale,
  store,
  subplatform,
  onOpenCustomers,
  onOpenProducts,
}: StoreTodayPanelProps) {
  const english = locale === "en";
  const [customersState, setCustomersState] =
    useState<ResourceState<StoreCustomerRecord[]>>(emptyCustomersState);
  const [offersState, setOffersState] =
    useState<ResourceState<MarketplaceOffer[]>>(emptyOffersState);
  const [refreshing, setRefreshing] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const requestVersionRef = useRef(0);
  const inFlightKeyRef = useRef<string | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const resourceKey = `${store.id}:${subplatform.domainId ?? "unconfigured"}`;
  const load = useCallback(async () => {
    if (inFlightKeyRef.current === resourceKey) return;

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    inFlightKeyRef.current = resourceKey;
    setRefreshing(true);
    setCustomersState((current) => ({ ...current, error: null }));
    setOffersState((current) => ({ ...current, error: null }));

    const [customersResult, offersResult] = await Promise.allSettled([
      getStoreCustomers(store.id),
      getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "seller",
      }).then(async (session) => {
          if (!subplatform.domainId || !session) {
            throw new Error(
              localeRef.current === "en"
                ? "The seller session is unavailable. Reopen the store workspace and retry."
                : "商家会话暂不可用，请重新打开店铺工作台后重试。",
            );
          }
          return getMarketplaceOffers({
            session,
            domainId: subplatform.domainId,
            limit: 100,
          });
        }),
    ]);

    if (requestVersionRef.current !== requestVersion) return;

    if (customersResult.status === "fulfilled") {
      setCustomersState({
        data: customersResult.value,
        loaded: true,
        error: null,
      });
    } else {
      setCustomersState((current) => ({
        ...current,
        error: resourceError(
          customersResult.reason,
          localeRef.current,
          "customers",
        ),
      }));
    }

    if (offersResult.status === "fulfilled") {
      setOffersState({ data: offersResult.value, loaded: true, error: null });
    } else {
      setOffersState((current) => ({
        ...current,
        error: resourceError(offersResult.reason, localeRef.current, "offers"),
      }));
    }

    setLastUpdatedAt(new Date());
    setRefreshing(false);
    inFlightKeyRef.current = null;
  }, [
    resourceKey,
    store.id,
    subplatform.domainId,
    subplatform.path,
    subplatform.slug,
    subplatform.tenantId,
  ]);

  useEffect(() => {
    setCustomersState(emptyCustomersState);
    setOffersState(emptyOffersState);
    setLastUpdatedAt(null);
    void load();

    return () => {
      requestVersionRef.current += 1;
      if (inFlightKeyRef.current === resourceKey) {
        inFlightKeyRef.current = null;
      }
    };
  }, [load, resourceKey]);

  const queues = useMemo(
    () => deriveTodayQueues(customersState.data, offersState.data),
    [customersState.data, offersState.data, lastUpdatedAt],
  );
  const primaryTask = useMemo(
    () => selectPrimaryTask(queues, locale),
    [locale, queues],
  );
  const liveMessage = refreshing
    ? customersState.loaded || offersState.loaded
      ? english
        ? "Refreshing today’s queues. Existing items remain available."
        : "正在刷新今日队列，现有待办仍可操作。"
      : english
        ? "Loading today’s queues."
        : "正在加载今日待办。"
    : customersState.error || offersState.error
      ? english
        ? "Some queues could not be refreshed. Retry is available in the affected queue."
        : "部分队列暂未刷新，可在对应队列中重试。"
      : english
        ? "Today’s queues are up to date."
        : "今日待办已更新。";

  return (
    <section className="store-today" aria-labelledby="store-today-title">
      <div className="store-today-heading">
        <div>
          <h2 id="store-today-title">
            {english ? "Today’s work" : "今日待办"}
          </h2>
          <p>
            {english
              ? "Built only from customer follow-up, contact consent, and offer update data. No appointments or deals are inferred."
              : "仅依据客户跟进、联系同意和商品更新时间汇总，不推测预约或成交。"}
          </p>
        </div>
        <Button
          variant="outline"
          size="md"
          className="store-today-refresh min-h-11"
          type="button"
          disabled={refreshing}
          onClick={() => void load()}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {refreshing
            ? english
              ? "Refreshing…"
              : "刷新中…"
            : english
              ? "Refresh"
              : "刷新"}
        </Button>
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </p>

      {primaryTask ? (
        <section
          className="store-today-primary"
          aria-labelledby="store-today-primary-title"
        >
          <div>
            <h3 id="store-today-primary-title">
              {english ? "Start here" : "先处理这一项"}
            </h3>
            <strong>{primaryTask.name}</strong>
            <p>{primaryTask.detail}</p>
          </div>
          <Button
            variant="primary"
            size="md"
            className="min-h-11"
            type="button"
            onClick={() => {
              if (primaryTask.kind === "customer") {
                onOpenCustomers(primaryTask.id);
              } else {
                onOpenProducts(primaryTask.id);
              }
            }}
          >
            {english ? "Open task" : "打开待办"}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </section>
      ) : null}

      <div className="store-today-queues">
        <TodayQueue
          locale={locale}
          id="new-customers"
          title={english ? "New or not followed up" : "新客户 / 未跟进"}
          count={queues.newCustomers.length}
          resource={customersState}
          refreshing={refreshing}
          emptyCopy={
            english
              ? "No customers are currently in the new stage."
              : "当前没有处于新客户阶段的记录。"
          }
          errorCopy={
            english
              ? "The new-customer queue could not be loaded."
              : "新客户队列暂时无法读取。"
          }
          manageLabel={english ? "Customer management" : "客户管理"}
          retryLabel={english ? "Retry customer queue" : "重试客户队列"}
          onManage={() => onOpenCustomers()}
          onRetry={load}
          renderItems={queues.newCustomers.map((customer) => ({
            id: customer.id,
            name: customer.displayName,
            detail: english
              ? `Last activity ${formatTimestamp(customer.lastActivityAt, locale)}`
              : `上次活动 ${formatTimestamp(customer.lastActivityAt, locale)}`,
            onOpen: () => onOpenCustomers(customer.id),
          }))}
        />
        <TodayQueue
          locale={locale}
          id="contact-customers"
          title={
            english
              ? "Contact consent or handoff"
              : "待联系同意 / 同意后未接待"
          }
          count={queues.contactCustomers.length}
          resource={customersState}
          refreshing={refreshing}
          emptyCopy={
            english
              ? "No consent or handoff needs attention."
              : "当前没有待确认或同意后未接待的客户。"
          }
          errorCopy={
            english
              ? "The contact queue could not be loaded."
              : "联系同意队列暂时无法读取。"
          }
          manageLabel={english ? "Customer management" : "客户管理"}
          retryLabel={english ? "Retry customer queue" : "重试客户队列"}
          onManage={() => onOpenCustomers()}
          onRetry={load}
          renderItems={queues.contactCustomers.map((customer) => ({
            id: customer.id,
            name: customer.displayName,
            detail:
              customer.contactConsentStatus === "pending"
                ? english
                  ? "Awaiting contact consent"
                  : "等待联系同意"
                : english
                  ? "Consent accepted; handoff not yet completed"
                  : "已同意联系，尚未完成接待",
            onOpen: () => onOpenCustomers(customer.id),
          }))}
        />
        <TodayQueue
          locale={locale}
          id="stale-high-intent"
          title={english ? "High intent inactive for 24h" : "高意向超过 24 小时未活动"}
          count={queues.staleHighIntentCustomers.length}
          resource={customersState}
          refreshing={refreshing}
          emptyCopy={
            english
              ? "No active high-intent customer is overdue."
              : "当前没有逾期未跟进的高意向客户。"
          }
          errorCopy={
            english
              ? "The high-intent queue could not be loaded."
              : "高意向客户队列暂时无法读取。"
          }
          manageLabel={english ? "Customer management" : "客户管理"}
          retryLabel={english ? "Retry customer queue" : "重试客户队列"}
          onManage={() => onOpenCustomers()}
          onRetry={load}
          renderItems={queues.staleHighIntentCustomers.map((customer) => ({
            id: customer.id,
            name: customer.displayName,
            detail: english
              ? `Last activity ${formatTimestamp(customer.lastActivityAt, locale)}`
              : `上次活动 ${formatTimestamp(customer.lastActivityAt, locale)}`,
            onOpen: () => onOpenCustomers(customer.id),
          }))}
        />
        <TodayQueue
          locale={locale}
          id="today-next-actions"
          title={english ? "Next actions scheduled today" : "今天已有下一步"}
          count={queues.todayNextActionCustomers.length}
          resource={customersState}
          refreshing={refreshing}
          emptyCopy={
            english
              ? "No structured next action is scheduled for today."
              : "今天没有已记录时间的结构化下一步。"
          }
          errorCopy={
            english
              ? "Today’s next-action queue could not be loaded."
              : "今天的下一步队列暂时无法读取。"
          }
          manageLabel={english ? "Customer management" : "客户管理"}
          retryLabel={english ? "Retry customer queue" : "重试客户队列"}
          onManage={() => onOpenCustomers()}
          onRetry={load}
          renderItems={queues.todayNextActionCustomers.map((customer) => ({
            id: customer.id,
            name: customer.displayName,
            detail: customer.nextAction ?? "",
            onOpen: () => onOpenCustomers(customer.id),
          }))}
        />
        <TodayQueue
          locale={locale}
          id="stale-offers"
          title={english ? "Active or draft offers stale for 24h" : "超过 24 小时未更新的商品"}
          count={queues.staleOffers.length}
          resource={offersState}
          refreshing={refreshing}
          emptyCopy={
            english
              ? "No active or draft offer needs an update."
              : "当前没有需要更新的上架商品或草稿。"
          }
          errorCopy={
            english
              ? "The offer queue could not be loaded."
              : "商品队列暂时无法读取。"
          }
          manageLabel={english ? "Offer management" : "商品管理"}
          retryLabel={english ? "Retry offer queue" : "重试商品队列"}
          onManage={() => onOpenProducts()}
          onRetry={load}
          renderItems={queues.staleOffers.map((offer) => ({
            id: offer.offer_id,
            name: offer.display_name,
            detail: english
              ? `${offer.status === "draft" ? "Draft" : "Active"} · Updated ${formatTimestamp(offer.updated_at, locale)}`
              : `${offer.status === "draft" ? "草稿" : "已上架"} · 更新于 ${formatTimestamp(offer.updated_at, locale)}`,
            onOpen: () => onOpenProducts(offer.offer_id),
          }))}
        />
      </div>
    </section>
  );
}

function TodayQueue<T>({
  locale,
  id,
  title,
  count,
  resource,
  refreshing,
  emptyCopy,
  errorCopy,
  manageLabel,
  retryLabel,
  onManage,
  onRetry,
  renderItems,
}: {
  locale: InterfaceLocale;
  id: string;
  title: string;
  count: number;
  resource: ResourceState<T>;
  refreshing: boolean;
  emptyCopy: string;
  errorCopy: string;
  manageLabel: string;
  retryLabel: string;
  onManage: () => void;
  onRetry: () => void | Promise<void>;
  renderItems: Array<{
    id: string;
    name: string;
    detail: string;
    onOpen: () => void;
  }>;
}) {
  const english = locale === "en";
  const visibleItems = renderItems.slice(0, VISIBLE_QUEUE_ITEMS);
  const hiddenCount = Math.max(0, renderItems.length - visibleItems.length);
  const unavailable = !resource.loaded && Boolean(resource.error);
  const initiallyLoading = !resource.loaded && refreshing && !resource.error;

  return (
    <section
      className="store-today-queue"
      aria-labelledby={`store-today-${id}-title`}
      aria-busy={initiallyLoading}
    >
      <div className="store-today-queue-heading">
        <div>
          <h3 id={`store-today-${id}-title`}>{title}</h3>
          <span
            className="store-today-count"
            aria-label={
              unavailable
                ? `${title}: ${english ? "unavailable" : "暂不可用"}`
                : initiallyLoading
                  ? `${title}: ${english ? "loading" : "加载中"}`
                  : `${title}: ${count}`
            }
          >
            {unavailable || initiallyLoading ? "—" : count}
          </span>
        </div>
        <button
          className="store-today-manage"
          type="button"
          onClick={onManage}
        >
          {manageLabel}
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>

      {initiallyLoading ? (
        <p className="store-today-state">
          {english ? "Loading…" : "正在加载…"}
        </p>
      ) : unavailable || (resource.error && !visibleItems.length) ? (
        <div className="store-today-state is-error">
          <p>{errorCopy}</p>
          <button type="button" onClick={() => void onRetry()}>
            {retryLabel}
          </button>
        </div>
      ) : visibleItems.length ? (
        <>
          {resource.error ? (
            <div className="store-today-state is-error is-inline">
              <p>{errorCopy}</p>
              <button type="button" onClick={() => void onRetry()}>
                {retryLabel}
              </button>
            </div>
          ) : null}
          <ul className="store-today-list">
            {visibleItems.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={item.onOpen}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {hiddenCount ? (
            <p className="store-today-more">
              +{hiddenCount} {manageLabel}
            </p>
          ) : null}
        </>
      ) : (
        <p className="store-today-state is-empty">{emptyCopy}</p>
      )}
    </section>
  );
}

function deriveTodayQueues(
  customers: StoreCustomerRecord[],
  offers: MarketplaceOffer[],
  now = new Date(),
): TodayQueues {
  const nowMs = now.getTime();
  return {
    newCustomers: customers.filter((customer) => customer.stage === "new"),
    contactCustomers: customers.filter(
      (customer) =>
        !TERMINAL_STAGES.has(customer.stage) &&
        customer.stage !== "contact_exchanged" &&
        (customer.contactConsentStatus === "pending" ||
          customer.contactConsentStatus === "accepted"),
    ),
    staleHighIntentCustomers: customers.filter(
      (customer) =>
        (customer.intent === "high" || customer.intent === "urgent") &&
        !TERMINAL_STAGES.has(customer.stage) &&
        isOlderThan(customer.lastActivityAt, nowMs, DAY_MS),
    ),
    todayNextActionCustomers: customers.filter(
      (customer) =>
        Boolean(customer.nextAction?.trim()) &&
        isSameLocalDay(customer.nextActionAt, now),
    ),
    staleOffers: offers.filter(
      (offer) =>
        (offer.status === "active" || offer.status === "draft") &&
        isOlderThan(offer.updated_at, nowMs, DAY_MS),
    ),
  };
}

function selectPrimaryTask(
  queues: TodayQueues,
  locale: InterfaceLocale,
): PrimaryTask | null {
  const english = locale === "en";
  const scheduled = queues.todayNextActionCustomers[0];
  if (scheduled) {
    return {
      kind: "customer",
      id: scheduled.id,
      name: scheduled.displayName,
      detail:
        scheduled.nextAction ??
        (english ? "Next action scheduled today" : "今天已有下一步"),
    };
  }

  const contact = queues.contactCustomers[0];
  if (contact) {
    return {
      kind: "customer",
      id: contact.id,
      name: contact.displayName,
      detail:
        contact.contactConsentStatus === "pending"
          ? english
            ? "Contact consent is pending"
            : "等待联系同意"
          : english
            ? "Consent accepted; handoff not yet completed"
            : "已同意联系，尚未完成接待",
    };
  }

  const staleHighIntent = queues.staleHighIntentCustomers[0];
  if (staleHighIntent) {
    return {
      kind: "customer",
      id: staleHighIntent.id,
      name: staleHighIntent.displayName,
      detail: english
        ? "High intent with no activity for more than 24 hours"
        : "高意向且超过 24 小时未活动",
    };
  }

  const newCustomer = queues.newCustomers[0];
  if (newCustomer) {
    return {
      kind: "customer",
      id: newCustomer.id,
      name: newCustomer.displayName,
      detail: english ? "New customer awaiting follow-up" : "新客户等待跟进",
    };
  }

  const staleOffer = queues.staleOffers[0];
  return staleOffer
    ? {
        kind: "offer",
        id: staleOffer.offer_id,
        name: staleOffer.display_name,
        detail: english
          ? "Active or draft offer unchanged for more than 24 hours"
          : "上架商品或草稿超过 24 小时未更新",
      }
    : null;
}

function isOlderThan(value: string, nowMs: number, thresholdMs: number) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < nowMs - thresholdMs;
}

function isSameLocalDay(value: string | null | undefined, today: Date) {
  if (!value) return false;
  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime())) return false;
  return (
    candidate.getFullYear() === today.getFullYear() &&
    candidate.getMonth() === today.getMonth() &&
    candidate.getDate() === today.getDate()
  );
}

function formatTimestamp(value: string, locale: InterfaceLocale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function resourceError(
  cause: unknown,
  locale: InterfaceLocale,
  resource: "customers" | "offers",
) {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (locale === "en") {
    return resource === "customers"
      ? "Customer queues are temporarily unavailable."
      : "Offer queues are temporarily unavailable.";
  }
  return resource === "customers"
    ? "客户队列暂时不可用。"
    : "商品队列暂时不可用。";
}
