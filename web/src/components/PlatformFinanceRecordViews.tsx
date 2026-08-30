"use client";

import type {
    InvoiceAdminRecord,
    PaymentAdminRecord,
    RefundAdminRecord,
} from "../api";
import {
    formatStoredMoneyAmount,
    remainingRefundAmount,
} from "../lib/payment-money";

export type FinanceView = "invoices" | "refunds";

type FinanceRecordListProps =
    | {
          view: "invoices";
          status: "loading" | "ready" | "error";
          records: InvoiceAdminRecord[];
      }
    | {
          view: "refunds";
          status: "loading" | "ready" | "error";
          records: RefundAdminRecord[];
      };

interface FinanceRecordRow {
    key: string;
    title: string;
    detail: string;
    updatedAt: string;
}

export function FinanceRecordList(props: FinanceRecordListProps) {
    const label = props.view === "invoices" ? "发票" : "退款";
    if (!props.records.length) {
        return (
            <p className="platform-access-empty">
                {props.status === "ready"
                    ? `暂无${label}记录。`
                    : props.status === "loading"
                      ? `${label}记录读取中…`
                      : `${label}记录暂时不可用。`}
            </p>
        );
    }

    const rows: FinanceRecordRow[] =
        props.view === "invoices"
            ? props.records.slice(0, 5).map((invoice) => ({
                  key: invoice.invoice_id,
                  title: invoice.invoice_number || invoice.kind,
                  detail: `${invoice.status} · ${formatStoredMoneyAmount(invoice.amount, invoice.currency_scale) ?? "金额无效"} ${invoice.currency}`,
                  updatedAt: invoice.updated_at,
              }))
            : props.records.slice(0, 5).map((refund) => ({
                  key: refund.refund_id,
                  title: `退款 ${refund.payment_id.slice(0, 8)}`,
                  detail: `${refund.status} · ${formatStoredMoneyAmount(refund.amount, refund.currency_scale) ?? "金额无效"} ${refund.currency}`,
                  updatedAt: refund.updated_at,
              }));

    return (
        <div className="finance-record-list" aria-label={`最近${label}`}>
            {props.status === "ready" ? null : (
                <p className="finance-record-stale">
                    以下是上次读取的数据，当前尚未验证。
                </p>
            )}
            {rows.map((row) => {
                const formattedDate = formatRecordDate(row.updatedAt);
                return (
                    <div className="finance-record-row" key={row.key}>
                        <span>
                            <strong>{row.title}</strong>
                            <small>{row.detail}</small>
                        </span>
                        {formattedDate ? (
                            <time dateTime={row.updatedAt}>
                                {formattedDate}
                            </time>
                        ) : (
                            <small>时间未知</small>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export function RefundEditor({
    tenantStatus,
    paymentsReady,
    capturedPayments,
    paymentId,
    amount,
    reason,
    saving,
    onPaymentIdChange,
    onAmountChange,
    onReasonChange,
    onSubmit,
}: {
    tenantStatus: "ready" | "verified-missing" | "unverified";
    paymentsReady: boolean;
    capturedPayments: PaymentAdminRecord[];
    paymentId: string;
    amount: string;
    reason: string;
    saving: boolean;
    onPaymentIdChange: (value: string) => void;
    onAmountChange: (value: string) => void;
    onReasonChange: (value: string) => void;
    onSubmit: () => void;
}) {
    if (tenantStatus === "unverified") {
        return (
            <p className="platform-access-empty">
                商城租户状态尚未验证，退款操作已暂停。请重新读取后再试。
            </p>
        );
    }
    if (tenantStatus === "verified-missing") {
        return (
            <p className="platform-access-empty">
                商城已确认尚未完成初始化，暂时不能提交退款。
            </p>
        );
    }
    if (!paymentsReady) {
        return (
            <p className="platform-access-empty">
                支付记录尚未完成最新验证，退款操作已暂停。请重新读取后再试。
            </p>
        );
    }
    if (!capturedPayments.length) {
        return (
            <p className="platform-access-empty">
                暂无已捕获且可退款的支付单。
            </p>
        );
    }

    const selectedPayment = capturedPayments.find(
        (payment) => payment.payment_id === paymentId,
    );
    const selectedRemaining = selectedPayment
        ? remainingRefundAmount(selectedPayment)
        : null;

    return (
        <form
            className="admin-editor refund-editor"
            aria-label="创建退款"
            onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
            }}
        >
            <div className="admin-editor-heading">
                <strong>提交退款</strong>
                <small>支持全额或部分退款；网关能力不足时会明确返回失败</small>
            </div>
            <label>
                <span>支付单</span>
                <select
                    required
                    value={paymentId}
                    disabled={saving}
                    onChange={(event) => onPaymentIdChange(event.target.value)}
                >
                    <option value="">选择已捕获支付</option>
                    {capturedPayments.map((payment) => (
                        <option
                            key={payment.payment_id}
                            value={payment.payment_id}
                        >
                            {payment.merchant_order_id || payment.payment_id} ·
                            剩余 {remainingRefundAmount(payment)}{" "}
                            {payment.currency}
                        </option>
                    ))}
                </select>
            </label>
            <div className="subplatform-form-grid">
                <label>
                    <span>退款金额</span>
                    <input
                        required
                        aria-label="退款金额"
                        value={amount}
                        disabled={saving}
                        inputMode="decimal"
                        placeholder="按支付单币种填写"
                        aria-describedby={
                            selectedPayment
                                ? "refund-amount-remaining"
                                : undefined
                        }
                        onChange={(event) => onAmountChange(event.target.value)}
                    />
                    {selectedPayment && selectedRemaining ? (
                        <small id="refund-amount-remaining">
                            剩余可退款 {selectedRemaining}{" "}
                            {selectedPayment.currency}；最多{" "}
                            {selectedPayment.currency_scale} 位小数
                        </small>
                    ) : null}
                </label>
                <label>
                    <span>退款原因</span>
                    <input
                        required
                        value={reason}
                        disabled={saving}
                        maxLength={2000}
                        placeholder="说明退款原因"
                        onChange={(event) => onReasonChange(event.target.value)}
                    />
                </label>
            </div>
            <button
                className="button button-dark"
                type="submit"
                disabled={saving}
            >
                {saving ? "提交中…" : "提交退款"}
            </button>
        </form>
    );
}

function formatRecordDate(value: string): string | null {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleDateString("zh-CN");
}
