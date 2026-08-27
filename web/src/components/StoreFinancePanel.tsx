"use client";

import { Badge } from "@appica/ui-react/badge";
import { Button } from "@appica/ui-react/button";
import { Skeleton } from "@appica/ui-react/skeleton";
import { Spinner } from "@appica/ui-react/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appica/ui-react/table";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getStoreFinanceReport, type StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import {
  formatStoreMoney,
  storeFinanceCsv,
  storeFinanceWindow,
  type StoreFinancePeriod,
  type StoreFinanceReport,
} from "../store-finance";

interface StoreFinancePanelProps {
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
  store: StoreSummary;
}

type FinanceDetail = {
  key: string;
  type: "payment" | "refund" | "invoice";
  reference: string;
  order: string;
  status: string;
  amount: string;
  currency: string;
  scale: number;
  occurredAt: string;
  note: string;
};

const copy = {
  zh: {
    title: "财务报表",
    subtitle: "成交、退款与发票",
    month: "本月",
    ninetyDays: "近 90 天",
    year: "今年",
    export: "导出 CSV",
    refresh: "刷新",
    gross: "成交总额",
    refunds: "退款",
    fees: "平台服务费",
    net: "净成交额",
    payments: "支付",
    invoices: "发票",
    details: "交易明细",
    reference: "编号",
    order: "订单",
    status: "状态",
    amount: "金额",
    time: "时间",
    empty: "这个周期没有财务记录",
    retry: "重试",
    loading: "财务报表读取中",
    failed: "财务报表读取失败",
    truncated: "明细超过 500 条，导出文件仅包含当前列表。",
    basis:
      "统计口径：支付创建、退款成功、发票申请时间。净成交额不等于银行结算到账。",
    exportReady: "财务报表已导出",
  },
  en: {
    title: "Financial report",
    subtitle: "Payments, refunds, and invoices",
    month: "This month",
    ninetyDays: "Last 90 days",
    year: "This year",
    export: "Export CSV",
    refresh: "Refresh",
    gross: "Gross captured",
    refunds: "Refunds",
    fees: "Platform fees",
    net: "Net revenue",
    payments: "Payments",
    invoices: "Invoices",
    details: "Transactions",
    reference: "Reference",
    order: "Order",
    status: "Status",
    amount: "Amount",
    time: "Time",
    empty: "No financial records in this period",
    retry: "Retry",
    loading: "Loading financial report",
    failed: "Could not load the financial report",
    truncated:
      "More than 500 records exist. The export contains the current list only.",
    basis:
      "Basis: payment creation, successful refunds, and invoice requests. Net revenue is not a bank settlement balance.",
    exportReady: "Financial report exported",
  },
} as const;

export function StoreFinancePanel({
  locale,
  onNotice,
  store,
}: StoreFinancePanelProps) {
  const text = copy[locale];
  const [period, setPeriod] = useState<StoreFinancePeriod>("month");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [report, setReport] = useState<StoreFinanceReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [currencyKey, setCurrencyKey] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const window = storeFinanceWindow(period);
    setLoading(true);
    setError("");
    void getStoreFinanceReport({
      storeId: store.id,
      ...window,
      signal: controller.signal,
    })
      .then((nextReport) => {
        setReport(nextReport);
        const firstCurrency = nextReport.currencies[0];
        setCurrencyKey((current) => {
          if (
            nextReport.currencies.some(
              (summary) =>
                currencyIdentity(summary.currency, summary.currency_scale) ===
                current,
            )
          )
            return current;
          return firstCurrency
            ? currencyIdentity(
                firstCurrency.currency,
                firstCurrency.currency_scale,
              )
            : "";
        });
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError")
          return;
        setReport(null);
        setError(cause instanceof Error ? cause.message : text.failed);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [period, refreshVersion, store.id, text.failed]);

  const summary =
    report?.currencies.find(
      (item) =>
        currencyIdentity(item.currency, item.currency_scale) === currencyKey,
    ) ??
    report?.currencies[0] ??
    null;
  const details = useMemo(
    () => financeDetails(report, summary?.currency, summary?.currency_scale),
    [report, summary],
  );

  function exportReport() {
    if (!report) return;
    const blob = new Blob(["\ufeff", storeFinanceCsv(report, locale)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${store.slug}-finance-${report.from.slice(0, 10)}-${report.to.slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice(text.exportReady);
  }

  return (
    <section className="space-y-6" aria-labelledby="store-finance-title">
      <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h3
            className="text-2xl font-semibold tracking-[-0.025em] text-foreground"
            id="store-finance-title"
          >
            {text.title}
          </h3>
          <p className="mt-1 text-sm text-foreground-muted">{text.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="store-finance-periods flex rounded-lg bg-background-muted p-1"
            aria-label={locale === "en" ? "Report period" : "报表周期"}
          >
            {(["month", "ninetyDays", "year"] as const).map((value) => (
              <Button
                className="min-h-11"
                key={value}
                size="md"
                type="button"
                variant={period === value ? "primary" : "ghost"}
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
              >
                {text[value]}
              </Button>
            ))}
          </div>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            size="md"
            onClick={() => setRefreshVersion((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw
              className={`size-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
              aria-hidden="true"
            />
            {text.refresh}
          </Button>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            size="md"
            onClick={exportReport}
            disabled={!report || details.length === 0}
          >
            <Download className="size-4" aria-hidden="true" />
            {text.export}
          </Button>
        </div>
      </header>

      {loading ? <FinanceLoading label={text.loading} /> : null}
      {!loading && error ? (
        <div
          className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-danger/40 px-5 text-center"
          role="alert"
        >
          <p className="font-medium text-foreground">{text.failed}</p>
          <p className="max-w-xl text-sm text-foreground-muted">{error}</p>
          <Button
            className="min-h-11 sm:min-h-9"
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            {text.retry}
          </Button>
        </div>
      ) : null}

      {!loading && !error && report ? (
        <>
          {report.currencies.length > 1 ? (
            <div
              className="flex flex-wrap gap-2"
              aria-label={locale === "en" ? "Currency" : "币种"}
            >
              {report.currencies.map((item) => {
                const identity = currencyIdentity(
                  item.currency,
                  item.currency_scale,
                );
                return (
                  <Button
                    className="min-h-11 sm:min-h-9"
                    key={identity}
                    type="button"
                    size="sm"
                    variant={identity === currencyKey ? "secondary" : "ghost"}
                    onClick={() => setCurrencyKey(identity)}
                  >
                    {item.currency}
                  </Button>
                );
              })}
            </div>
          ) : null}

          {summary ? (
            <div className="grid grid-cols-2 border-y border-border md:grid-cols-4">
              <Metric
                label={text.gross}
                value={formatStoreMoney(
                  summary.gross_captured,
                  summary.currency_scale,
                  summary.currency,
                  locale,
                )}
              />
              <Metric
                label={text.refunds}
                value={formatStoreMoney(
                  summary.refunded,
                  summary.currency_scale,
                  summary.currency,
                  locale,
                )}
              />
              <Metric
                label={text.fees}
                value={formatStoreMoney(
                  summary.platform_fees,
                  summary.currency_scale,
                  summary.currency,
                  locale,
                )}
              />
              <Metric
                label={text.net}
                value={formatStoreMoney(
                  summary.net_revenue,
                  summary.currency_scale,
                  summary.currency,
                  locale,
                )}
                strong
              />
            </div>
          ) : (
            <FinanceEmpty message={text.empty} />
          )}

          {summary ? (
            <p className="text-sm text-foreground-muted">
              {text.payments} {summary.payment_count} · {text.refunds}{" "}
              {summary.refund_count} · {text.invoices} {summary.invoice_count}
            </p>
          ) : null}

          {report.truncated ? (
            <p
              className="rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning-foreground"
              role="alert"
            >
              {text.truncated}
            </p>
          ) : null}

          {details.length > 0 ? (
            <FinanceDetails details={details} locale={locale} text={text} />
          ) : summary ? (
            <FinanceEmpty message={text.empty} />
          ) : null}
          <p className="text-xs leading-5 text-foreground-subtle">
            {text.basis}
          </p>
        </>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-border px-3 py-5 even:border-l md:border-b-0 md:border-l md:first:border-l-0">
      <p className="text-xs font-medium text-foreground-muted">{label}</p>
      <p
        className={`mt-2 truncate text-xl tabular-nums tracking-[-0.02em] md:text-2xl ${strong ? "font-semibold text-foreground" : "font-medium text-foreground"}`}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function FinanceLoading({ label }: { label: string }) {
  return (
    <div className="space-y-5" aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
        {[0, 1, 2, 3].map((value) => (
          <Skeleton className="h-24 rounded-none bg-background" key={value} />
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-foreground-muted">
        <Spinner currentColor />
        {label}
      </div>
    </div>
  );
}

function FinanceEmpty({ message }: { message: string }) {
  return (
    <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-border px-5 text-center text-sm text-foreground-muted">
      {message}
    </div>
  );
}

function FinanceDetails({
  details,
  locale,
  text,
}: {
  details: FinanceDetail[];
  locale: InterfaceLocale;
  text: typeof copy.zh | typeof copy.en;
}) {
  return (
    <section className="space-y-3" aria-labelledby="finance-details-title">
      <h4
        className="text-lg font-semibold text-foreground"
        id="finance-details-title"
      >
        {text.details}
      </h4>
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <Table size="sm" hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead>{text.reference}</TableHead>
              <TableHead>{text.order}</TableHead>
              <TableHead>{text.status}</TableHead>
              <TableHead className="text-right">{text.amount}</TableHead>
              <TableHead className="text-right">{text.time}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {details.map((detail) => (
              <TableRow key={detail.key}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <TypeBadge type={detail.type} locale={locale} />
                    <span
                      className="max-w-40 truncate font-medium"
                      title={detail.reference}
                    >
                      {shortReference(detail.reference)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <span
                    className="block max-w-44 truncate text-foreground-muted"
                    title={detail.order}
                  >
                    {detail.order || "—"}
                  </span>
                </TableCell>
                <TableCell>{statusLabel(detail.status, locale)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatStoreMoney(
                    detail.amount,
                    detail.scale,
                    detail.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right text-foreground-muted">
                  {formatDate(detail.occurredAt, locale)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y divide-border rounded-xl border border-border md:hidden">
        {details.map((detail) => (
          <article className="space-y-3 px-4 py-4" key={detail.key}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <TypeBadge type={detail.type} locale={locale} />
                <span className="truncate font-medium">
                  {shortReference(detail.reference)}
                </span>
              </div>
              <span className="shrink-0 font-semibold tabular-nums">
                {formatStoreMoney(
                  detail.amount,
                  detail.scale,
                  detail.currency,
                  locale,
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs text-foreground-muted">
              <span className="truncate">
                {detail.order || detail.note || "—"}
              </span>
              <span className="shrink-0">
                {statusLabel(detail.status, locale)} ·{" "}
                {formatDate(detail.occurredAt, locale)}
              </span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TypeBadge({
  type,
  locale,
}: {
  type: FinanceDetail["type"];
  locale: InterfaceLocale;
}) {
  const labels =
    locale === "en"
      ? { payment: "Payment", refund: "Refund", invoice: "Invoice" }
      : { payment: "支付", refund: "退款", invoice: "发票" };
  return (
    <Badge size="xs" variant={type === "payment" ? "success" : "outline"}>
      {labels[type]}
    </Badge>
  );
}

function financeDetails(
  report: StoreFinanceReport | null,
  currency?: string,
  scale?: number,
): FinanceDetail[] {
  if (!report || !currency || scale === undefined) return [];
  return [
    ...report.payments
      .filter(
        (item) => item.currency === currency && item.currency_scale === scale,
      )
      .map((item) => ({
        key: `payment:${item.payment_id}`,
        type: "payment" as const,
        reference: item.payment_id,
        order: item.merchant_order_id,
        status: item.status,
        amount: item.captured_amount,
        currency: item.currency,
        scale: item.currency_scale,
        occurredAt: item.created_at,
        note: "",
      })),
    ...report.refunds
      .filter(
        (item) => item.currency === currency && item.currency_scale === scale,
      )
      .map((item) => ({
        key: `refund:${item.refund_id}`,
        type: "refund" as const,
        reference: item.refund_id,
        order: item.merchant_order_id,
        status: item.status,
        amount: item.amount.startsWith("-") ? item.amount : `-${item.amount}`,
        currency: item.currency,
        scale: item.currency_scale,
        occurredAt: item.created_at,
        note: item.reason,
      })),
    ...report.invoices
      .filter(
        (item) => item.currency === currency && item.currency_scale === scale,
      )
      .map((item) => ({
        key: `invoice:${item.invoice_id}`,
        type: "invoice" as const,
        reference: item.invoice_number || item.invoice_id,
        order: item.payment_id || "",
        status: item.status,
        amount: item.amount,
        currency: item.currency,
        scale: item.currency_scale,
        occurredAt: item.requested_at,
        note: item.description,
      })),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function currencyIdentity(currency: string, scale: number) {
  return `${currency}:${scale}`;
}

function shortReference(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatDate(value: string, locale: InterfaceLocale) {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: string, locale: InterfaceLocale) {
  const labels: Record<string, [string, string]> = {
    captured: ["已支付", "Captured"],
    authorized: ["已授权", "Authorized"],
    pending: ["处理中", "Pending"],
    requested: ["已申请", "Requested"],
    succeeded: ["已完成", "Succeeded"],
    issued: ["已开具", "Issued"],
    failed: ["失败", "Failed"],
    voided: ["已作废", "Voided"],
    unknown: ["待确认", "Unknown"],
  };
  const label = labels[status];
  if (!label) return status;
  return locale === "en" ? label[1] : label[0];
}
