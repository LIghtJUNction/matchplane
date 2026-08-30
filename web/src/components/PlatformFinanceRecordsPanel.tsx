"use client";

import { Button } from "@appica/ui-react/button";
import { AlertTriangle, ReceiptText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createAdminRefund,
  getInvoiceAdminRecords,
  getPaymentAdminRecords,
  getRefundAdminRecords,
  type InvoiceAdminRecord,
  type PaymentAdminRecord,
  type RefundAdminRecord,
} from "../api";
import {
  isRefundablePayment,
  refundAmountMinorUnits,
} from "../lib/payment-money";
import {
  FinanceRecordList,
  type FinanceView,
  RefundEditor,
} from "./PlatformFinanceRecordViews";

type PlatformFinanceTenantState =
  | { status: "unverified" }
  | { status: "verified"; tenantId: string | null };

interface PlatformFinanceRecordsPanelProps {
  authorized: boolean;
  apiAvailable: boolean;
  tenant: PlatformFinanceTenantState;
  onNotice: (message: string) => void;
}

type FinanceResourceKey = "payments" | "refunds" | "invoices";
type FinanceResourceState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; previous?: T };

const FINANCE_RESOURCE_KEYS = [
  "payments",
  "refunds",
  "invoices",
] as const satisfies readonly FinanceResourceKey[];

const resourceLabels: Record<FinanceResourceKey, string> = {
  payments: "支付记录",
  refunds: "退款记录",
  invoices: "发票记录",
};

export function PlatformFinanceRecordsPanel({
  authorized,
  apiAvailable,
  tenant,
  onNotice,
}: PlatformFinanceRecordsPanelProps) {
  const [payments, setPayments] = useState<
    FinanceResourceState<PaymentAdminRecord[]>
  >({ status: "loading" });
  const [refunds, setRefunds] = useState<
    FinanceResourceState<RefundAdminRecord[]>
  >({ status: "loading" });
  const [invoices, setInvoices] = useState<
    FinanceResourceState<InvoiceAdminRecord[]>
  >({ status: "loading" });
  const [view, setView] = useState<FinanceView>("invoices");
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundSaving, setRefundSaving] = useState(false);
  const requestVersions = useRef<Record<FinanceResourceKey, number>>({
    payments: 0,
    refunds: 0,
    invoices: 0,
  });
  const mountedRef = useRef(false);
  const refundSubmissionRef = useRef(0);
  const refundSubmittingRef = useRef(false);
  const refundIdempotencyRef = useRef<{
    fingerprint: string;
    key: string;
  } | null>(null);

  const loadPayments = useCallback(async () => {
    const requestVersion = ++requestVersions.current.payments;
    setPayments((current) => loadingState(current));
    try {
      const data = await getPaymentAdminRecords();
      if (requestVersions.current.payments !== requestVersion) return;
      setPayments({ status: "ready", data });
    } catch (cause) {
      if (requestVersions.current.payments !== requestVersion) return;
      setPayments((current) =>
        errorState(current, readableError(cause, "支付记录读取失败")),
      );
    }
  }, []);

  const loadRefunds = useCallback(async () => {
    const requestVersion = ++requestVersions.current.refunds;
    setRefunds((current) => loadingState(current));
    try {
      const data = await getRefundAdminRecords();
      if (requestVersions.current.refunds !== requestVersion) return;
      setRefunds({ status: "ready", data });
    } catch (cause) {
      if (requestVersions.current.refunds !== requestVersion) return;
      setRefunds((current) =>
        errorState(current, readableError(cause, "退款记录读取失败")),
      );
    }
  }, []);

  const loadInvoices = useCallback(async () => {
    const requestVersion = ++requestVersions.current.invoices;
    setInvoices((current) => loadingState(current));
    try {
      const data = await getInvoiceAdminRecords();
      if (requestVersions.current.invoices !== requestVersion) return;
      setInvoices({ status: "ready", data });
    } catch (cause) {
      if (requestVersions.current.invoices !== requestVersion) return;
      setInvoices((current) =>
        errorState(current, readableError(cause, "发票记录读取失败")),
      );
    }
  }, []);

  const loadResources = useCallback(
    async (keys: readonly FinanceResourceKey[]) => {
      await Promise.all(
        keys.map((key) => {
          if (key === "payments") return loadPayments();
          if (key === "refunds") return loadRefunds();
          return loadInvoices();
        }),
      );
    },
    [loadInvoices, loadPayments, loadRefunds],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (authorized && apiAvailable) void loadResources(FINANCE_RESOURCE_KEYS);
    return () => {
      mountedRef.current = false;
      requestVersions.current.payments += 1;
      requestVersions.current.refunds += 1;
      requestVersions.current.invoices += 1;
      refundSubmissionRef.current += 1;
      refundSubmittingRef.current = false;
      refundIdempotencyRef.current = null;
    };
  }, [apiAvailable, authorized, loadResources]);

  const states = { payments, refunds, invoices };
  const failedKeys = FINANCE_RESOURCE_KEYS.filter(
    (key) => states[key].status === "error",
  );
  const loadingKeys = FINANCE_RESOURCE_KEYS.filter(
    (key) => states[key].status === "loading",
  );
  const staleKeys = FINANCE_RESOURCE_KEYS.filter((key) => {
    const state = states[key];
    return state.status !== "ready" && state.previous !== undefined;
  });
  const allReady = FINANCE_RESOURCE_KEYS.every(
    (key) => states[key].status === "ready",
  );
  const allEmpty =
    allReady &&
    FINANCE_RESOURCE_KEYS.every((key) => {
      const state = states[key];
      return state.status === "ready" && state.data.length === 0;
    });
  const freshPayments = payments.status === "ready" ? payments.data : null;
  const capturedPayments = freshPayments?.filter(isRefundablePayment) ?? [];

  async function submitRefund() {
    if (refundSubmittingRef.current) return;
    if (tenant.status !== "verified") {
      onNotice("商城租户状态尚未验证，请重新读取后再提交退款");
      return;
    }
    const selectedPayment = capturedPayments.find(
      (payment) => payment.payment_id === refundPaymentId,
    );
    if (
      !tenant.tenantId ||
      !selectedPayment ||
      !refundAmount.trim() ||
      !refundReason.trim()
    ) {
      onNotice("请选择已验证的可退款支付单，并填写退款金额和原因");
      return;
    }

    const amount = refundAmount.trim();
    const reason = refundReason.trim();
    const amountMinorUnits = refundAmountMinorUnits(selectedPayment, amount);
    if (amountMinorUnits === null) {
      onNotice("退款金额必须大于零、符合币种精度，且不得超过剩余可退款金额");
      return;
    }

    const fingerprint = JSON.stringify([
      tenant.tenantId,
      selectedPayment.payment_id,
      amountMinorUnits,
      reason,
    ]);
    let idempotency = refundIdempotencyRef.current;
    if (idempotency?.fingerprint !== fingerprint) {
      idempotency = {
        fingerprint,
        key: `web-refund-${crypto.randomUUID()}`,
      };
      refundIdempotencyRef.current = idempotency;
    }

    refundSubmittingRef.current = true;
    const submissionVersion = ++refundSubmissionRef.current;
    setRefundSaving(true);
    try {
      await createAdminRefund({
        tenantId: tenant.tenantId,
        paymentId: selectedPayment.payment_id,
        amount: amountMinorUnits,
        reason,
        idempotencyKey: idempotency.key,
      });
      if (
        !mountedRef.current ||
        refundSubmissionRef.current !== submissionVersion
      )
        return;
      refundIdempotencyRef.current = null;
      setRefundPaymentId("");
      setRefundAmount("");
      setRefundReason("");
      onNotice("退款请求已提交；最终状态以支付网关回调和对账为准");
      await loadResources(FINANCE_RESOURCE_KEYS);
    } catch (cause) {
      if (
        mountedRef.current &&
        refundSubmissionRef.current === submissionVersion
      ) {
        onNotice(readableError(cause, "退款请求提交失败"));
      }
    } finally {
      if (
        mountedRef.current &&
        refundSubmissionRef.current === submissionVersion
      ) {
        setRefundSaving(false);
        refundSubmittingRef.current = false;
      }
    }
  }

  if (!authorized) {
    return (
      <div className="finance-resource-status" role="status">
        需要商城负责人或管理员权限才能查看财务记录或提交退款。
      </div>
    );
  }

  if (!apiAvailable) {
    return (
      <div className="finance-resource-status" role="status">
        当前部署未启用平台 API，暂时无法读取财务记录或提交退款。
      </div>
    );
  }

  return (
    <div className="platform-finance-records">
      {loadingKeys.length ? (
        <div className="finance-resource-status" role="status">
          {staleKeys.length
            ? `正在重新验证${loadingKeys.map((key) => resourceLabels[key]).join("、")}；旧数据仅供参考。`
            : `正在读取${loadingKeys.map((key) => resourceLabels[key]).join("、")}…`}
        </div>
      ) : null}
      {failedKeys.length ? (
        <div className="finance-resource-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>部分财务记录暂时无法验证</strong>
            <ul>
              {failedKeys.map((key) => {
                const state = states[key];
                return (
                  <li key={key}>
                    {resourceLabels[key]}：
                    {state.status === "error" ? state.message : "读取失败"}
                    {state.status === "error" && state.previous !== undefined
                      ? "；保留的旧数据已标记为待验证"
                      : ""}
                  </li>
                );
              })}
            </ul>
          </div>
          <Button
            className="min-h-11 sm:min-h-9"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void loadResources(failedKeys)}
          >
            <RefreshCw size={15} aria-hidden="true" />
            重新读取失败项
          </Button>
        </div>
      ) : null}

      <div className="finance-empty">
        <ReceiptText size={22} aria-hidden="true" />
        {allEmpty ? (
          <p>暂无财务记录；接入支付服务后，这里会显示真实事件。</p>
        ) : (
          <p>
            最近记录：支付 {countLabel(payments, "笔")}、发票{" "}
            {countLabel(invoices, "张")}、退款 {countLabel(refunds, "笔")}。
            {staleKeys.length ? " 保留的旧记录仅供参考。" : ""}
          </p>
        )}
      </div>

      <div
        className="finance-record-tabs"
        role="group"
        aria-label="财务记录类型"
      >
        <Button
          className="min-h-11"
          size="md"
          type="button"
          variant={view === "invoices" ? "primary" : "ghost"}
          aria-pressed={view === "invoices"}
          onClick={() => setView("invoices")}
        >
          发票记录
        </Button>
        <Button
          className="min-h-11"
          size="md"
          type="button"
          variant={view === "refunds" ? "primary" : "ghost"}
          aria-pressed={view === "refunds"}
          onClick={() => setView("refunds")}
        >
          退款与退款申请
        </Button>
      </div>

      {view === "invoices" ? (
        <FinanceRecordList
          view="invoices"
          status={invoices.status}
          records={resourceData(invoices) ?? []}
        />
      ) : (
        <FinanceRecordList
          view="refunds"
          status={refunds.status}
          records={resourceData(refunds) ?? []}
        />
      )}

      {view === "refunds" ? (
        <RefundEditor
          tenantStatus={
            tenant.status === "unverified"
              ? "unverified"
              : tenant.tenantId
                ? "ready"
                : "verified-missing"
          }
          paymentsReady={payments.status === "ready"}
          capturedPayments={capturedPayments}
          paymentId={refundPaymentId}
          amount={refundAmount}
          reason={refundReason}
          saving={refundSaving}
          onPaymentIdChange={setRefundPaymentId}
          onAmountChange={setRefundAmount}
          onReasonChange={setRefundReason}
          onSubmit={() => void submitRefund()}
        />
      ) : null}
    </div>
  );
}

function loadingState<T>(
  state: FinanceResourceState<T>,
): FinanceResourceState<T> {
  const previous = resourceData(state);
  return previous === undefined
    ? { status: "loading" }
    : { status: "loading", previous };
}

function errorState<T>(
  state: FinanceResourceState<T>,
  message: string,
): FinanceResourceState<T> {
  const previous = resourceData(state);
  return previous === undefined
    ? { status: "error", message }
    : { status: "error", message, previous };
}

function resourceData<T>(state: FinanceResourceState<T>): T | undefined {
  return state.status === "ready" ? state.data : state.previous;
}

function countLabel<T>(
  state: FinanceResourceState<T[]>,
  unit: "笔" | "张",
): string {
  if (state.status === "ready") return `${state.data.length} ${unit}`;
  return state.previous === undefined
    ? "—"
    : `—（保留 ${state.previous.length} ${unit}旧记录）`;
}

function readableError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : fallback;
}
