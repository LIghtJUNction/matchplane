import type { InterfaceLocale } from "./lib/preferences";

export type StoreFinancePeriod = "month" | "ninetyDays" | "year";

export interface StoreFinanceCurrencySummary {
  currency: string;
  currency_scale: number;
  gross_captured: string;
  refunded: string;
  platform_fees: string;
  net_revenue: string;
  payment_count: number;
  captured_count: number;
  refund_count: number;
  invoice_count: number;
}

export interface StoreFinancePayment {
  payment_id: string;
  merchant_order_id: string;
  status: string;
  amount: string;
  captured_amount: string;
  refunded_amount: string;
  platform_fee: string;
  currency: string;
  currency_scale: number;
  created_at: string;
}

export interface StoreFinanceRefund {
  refund_id: string;
  payment_id: string;
  merchant_order_id: string;
  status: string;
  amount: string;
  platform_fee_reversal: string;
  currency: string;
  currency_scale: number;
  reason: string;
  created_at: string;
}

export interface StoreFinanceInvoice {
  invoice_id: string;
  payment_id?: string | null;
  status: string;
  kind: string;
  amount: string;
  currency: string;
  currency_scale: number;
  description: string;
  invoice_number?: string | null;
  requested_at: string;
  issued_at?: string | null;
}

export interface StoreFinanceReport {
  tenant_id: string;
  source_type: "store";
  source_ref: string;
  from: string;
  to: string;
  generated_at: string;
  basis: "payment_created_refund_created_invoice_requested";
  currencies: StoreFinanceCurrencySummary[];
  payments: StoreFinancePayment[];
  refunds: StoreFinanceRefund[];
  invoices: StoreFinanceInvoice[];
  truncated: boolean;
}

export function storeFinanceWindow(
  period: StoreFinancePeriod,
  now = new Date(),
): { from: string; to: string } {
  const to = new Date(now);
  let from: Date;
  if (period === "month") {
    from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  } else if (period === "year") {
    from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
  } else {
    from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1_000);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export function formatStoreMoney(
  amount: string,
  scale: number,
  currency: string,
  locale: InterfaceLocale,
): string {
  const value = BigInt(amount);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const integer = absolute / divisor;
  const fraction =
    scale > 0 ? (absolute % divisor).toString().padStart(scale, "0") : "";
  let formattedValue: bigint | number = integer;
  if (negative) formattedValue = integer === 0n ? -0 : -integer;
  const parts = new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).formatToParts(formattedValue);
  if (!fraction) return parts.map((part) => part.value).join("");
  let lastNumberPart = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.type === "integer" || parts[index]?.type === "group")
      lastNumberPart = index;
  }
  parts.splice(
    lastNumberPart + 1,
    0,
    { type: "decimal", value: "." },
    { type: "fraction", value: fraction },
  );
  return parts.map((part) => part.value).join("");
}

export function storeFinanceCsv(
  report: StoreFinanceReport,
  locale: InterfaceLocale,
): string {
  const headers =
    locale === "en"
      ? [
          "Type",
          "Reference",
          "Order",
          "Status",
          "Amount",
          "Currency",
          "Occurred at",
          "Description",
        ]
      : ["类型", "编号", "订单", "状态", "金额", "币种", "发生时间", "说明"];
  const rows = [
    ...report.payments.map((payment) => ({
      type: locale === "en" ? "Payment" : "支付",
      reference: payment.payment_id,
      order: payment.merchant_order_id,
      status: payment.status,
      amount: exactDecimal(payment.captured_amount, payment.currency_scale),
      currency: payment.currency,
      occurredAt: payment.created_at,
      description: "",
    })),
    ...report.refunds.map((refund) => ({
      type: locale === "en" ? "Refund" : "退款",
      reference: refund.refund_id,
      order: refund.merchant_order_id,
      status: refund.status,
      amount: `-${exactDecimal(refund.amount, refund.currency_scale)}`,
      currency: refund.currency,
      occurredAt: refund.created_at,
      description: refund.reason,
    })),
    ...report.invoices.map((invoice) => ({
      type: locale === "en" ? "Invoice" : "发票",
      reference: invoice.invoice_number || invoice.invoice_id,
      order: invoice.payment_id || "",
      status: invoice.status,
      amount: exactDecimal(invoice.amount, invoice.currency_scale),
      currency: invoice.currency,
      occurredAt: invoice.requested_at,
      description: invoice.description,
    })),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  return [
    headers,
    ...rows.map((row) => [
      row.type,
      row.reference,
      row.order,
      row.status,
      row.amount,
      row.currency,
      row.occurredAt,
      row.description,
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function exactDecimal(amount: string, scale: number): string {
  const negative = amount.startsWith("-");
  const digits = negative ? amount.slice(1) : amount;
  if (scale === 0) return amount;
  const padded = digits.padStart(scale + 1, "0");
  const decimal = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  return negative ? `-${decimal}` : decimal;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
