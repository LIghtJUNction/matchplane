import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPaymentAdminRecords: vi.fn(),
  getRefundAdminRecords: vi.fn(),
  getInvoiceAdminRecords: vi.fn(),
  createAdminRefund: vi.fn(),
}));

vi.mock("../api", () => api);

import type {
  InvoiceAdminRecord,
  PaymentAdminRecord,
  RefundAdminRecord,
} from "../api";
import { PlatformFinanceRecordsPanel } from "./PlatformFinanceRecordsPanel";

const tenantId = "11111111-1111-4111-8111-111111111111";
const verifiedTenant = { status: "verified", tenantId } as const;

const capturedPayment = {
  payment_id: "22222222-2222-4222-8222-222222222222",
  tenant_id: tenantId,
  gateway_id: "33333333-3333-4333-8333-333333333333",
  merchant_order_id: "ORDER-001",
  transaction_channel: "marketplace_checkout",
  purpose: "order",
  gateway_kind: "test",
  gateway_mode: "test",
  payment_method: "card",
  amount: "12000",
  captured_amount: "12000",
  refunded_amount: "0",
  commission_amount: "600",
  commission_refunded_amount: "0",
  currency: "CNY",
  currency_scale: 2,
  status: "captured",
  provider_reference: "payment-provider-1",
  provider_status: "captured",
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
} satisfies PaymentAdminRecord;

const invoice = {
  invoice_id: "44444444-4444-4444-8444-444444444444",
  tenant_id: tenantId,
  payment_id: capturedPayment.payment_id,
  kind: "payment_invoice",
  amount: "12000",
  currency: "CNY",
  currency_scale: 2,
  description: "ORDER-001 invoice",
  status: "issued",
  provider_key: "local_test",
  provider_mode: "test",
  provider_reference: "invoice-provider-1",
  invoice_number: "INV-001",
  requested_by: "root-admin",
  requested_at: "2026-08-25T00:00:00.000Z",
  issued_at: "2026-08-25T00:01:00.000Z",
  updated_at: "2026-08-25T00:01:00.000Z",
} satisfies InvoiceAdminRecord;

const refund = {
  refund_id: "55555555-5555-4555-8555-555555555555",
  tenant_id: tenantId,
  payment_id: capturedPayment.payment_id,
  amount: "2000",
  commission_reversal_amount: "100",
  currency: "CNY",
  currency_scale: 2,
  reason: "customer request",
  status: "pending",
  provider_reference: null,
  provider_status: "pending",
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
} satisfies RefundAdminRecord;

beforeEach(() => {
  api.getPaymentAdminRecords.mockReset().mockResolvedValue([]);
  api.getRefundAdminRecords.mockReset().mockResolvedValue([]);
  api.getInvoiceAdminRecords.mockReset().mockResolvedValue([]);
  api.createAdminRefund.mockReset().mockResolvedValue(refund);
});

describe("PlatformFinanceRecordsPanel", () => {
  it("distinguishes initial loading from a verified empty result", async () => {
    const paymentsRequest = deferred<PaymentAdminRecord[]>();
    const refundsRequest = deferred<RefundAdminRecord[]>();
    const invoicesRequest = deferred<InvoiceAdminRecord[]>();
    api.getPaymentAdminRecords.mockReturnValueOnce(paymentsRequest.promise);
    api.getRefundAdminRecords.mockReturnValueOnce(refundsRequest.promise);
    api.getInvoiceAdminRecords.mockReturnValueOnce(invoicesRequest.promise);

    render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={verifiedTenant}
        onNotice={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "正在读取支付记录、退款记录、发票记录",
    );
    expect(screen.queryByText(/暂无财务记录/)).not.toBeInTheDocument();

    await act(async () => {
      paymentsRequest.resolve([]);
      refundsRequest.resolve([]);
      invoicesRequest.resolve([]);
      await Promise.all([
        paymentsRequest.promise,
        refundsRequest.promise,
        invoicesRequest.promise,
      ]);
    });

    expect(await screen.findByText(/暂无财务记录/)).toBeInTheDocument();
    expect(screen.getByText("暂无发票记录。")).toBeInTheDocument();
  });

  it("keeps fulfilled resources visible and retries only the failed resource", async () => {
    api.getPaymentAdminRecords.mockResolvedValue([capturedPayment]);
    api.getInvoiceAdminRecords.mockResolvedValue([invoice]);
    api.getRefundAdminRecords
      .mockRejectedValueOnce(new Error("退款服务暂时不可用"))
      .mockResolvedValueOnce([]);
    const user = userEvent.setup();

    render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={verifiedTenant}
        onNotice={vi.fn()}
      />,
    );

    expect(await screen.findByText("INV-001")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "退款服务暂时不可用",
    );
    await user.click(screen.getByRole("button", { name: "退款与退款申请" }));
    expect(screen.getByText("退款记录暂时不可用。")).toBeInTheDocument();
    expect(screen.queryByText("暂无退款记录。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "发票记录" }));

    await user.click(screen.getByRole("button", { name: "重新读取失败项" }));
    expect(screen.getByText("INV-001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "退款与退款申请" }));

    expect(await screen.findByText("暂无退款记录。")).toBeInTheDocument();
    expect(api.getPaymentAdminRecords).toHaveBeenCalledTimes(1);
    expect(api.getInvoiceAdminRecords).toHaveBeenCalledTimes(1);
    expect(api.getRefundAdminRecords).toHaveBeenCalledTimes(2);
  });

  it("keeps stale payments visible but pauses refunds after a successful POST refresh fails", async () => {
    api.getPaymentAdminRecords
      .mockResolvedValue([capturedPayment])
      .mockResolvedValueOnce([capturedPayment])
      .mockRejectedValueOnce(new Error("支付记录重新验证失败"));
    const onNotice = vi.fn();
    const user = userEvent.setup();

    render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={verifiedTenant}
        onNotice={onNotice}
      />,
    );

    await screen.findByText(/支付 1 笔/);
    await user.click(screen.getByRole("button", { name: "退款与退款申请" }));
    expect(screen.getByLabelText("支付单")).toBeRequired();
    expect(screen.getByLabelText("退款金额")).toBeRequired();
    expect(screen.getByLabelText("退款原因")).toBeRequired();
    await user.selectOptions(screen.getByLabelText("支付单"), [
      capturedPayment.payment_id,
    ]);
    await user.type(screen.getByLabelText("退款金额"), "20.00");
    await user.type(screen.getByLabelText("退款原因"), "客户申请退款");
    await user.click(screen.getByRole("button", { name: "提交退款" }));

    await waitFor(() =>
      expect(api.createAdminRefund).toHaveBeenCalledWith({
        tenantId,
        paymentId: capturedPayment.payment_id,
        amount: "2000",
        reason: "客户申请退款",
        idempotencyKey: expect.stringMatching(/^web-refund-/),
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "支付记录重新验证失败",
    );
    expect(screen.getByText(/支付 —（保留 1 笔旧记录）/)).toBeInTheDocument();
    expect(
      screen.getByText(/支付记录尚未完成最新验证，退款操作已暂停/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交退款" }),
    ).not.toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith(
      "退款请求已提交；最终状态以支付网关回调和对账为准",
    );

    await user.click(screen.getByRole("button", { name: "重新读取失败项" }));

    expect(
      await screen.findByRole("button", { name: "提交退款" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("支付单")).toHaveValue("");
    expect(screen.getByLabelText("退款金额")).toHaveValue("");
    expect(screen.getByLabelText("退款原因")).toHaveValue("");
    expect(api.createAdminRefund).toHaveBeenCalledTimes(1);
    expect(api.getPaymentAdminRecords).toHaveBeenCalledTimes(3);
    expect(api.getRefundAdminRecords).toHaveBeenCalledTimes(2);
    expect(api.getInvoiceAdminRecords).toHaveBeenCalledTimes(2);
  });

  it("preserves refund input and does not refresh when the POST fails", async () => {
    api.getPaymentAdminRecords.mockResolvedValue([capturedPayment]);
    api.createAdminRefund.mockRejectedValueOnce(
      new Error("支付网关拒绝了退款"),
    );
    const onNotice = vi.fn();
    const user = userEvent.setup();

    render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={verifiedTenant}
        onNotice={onNotice}
      />,
    );

    await screen.findByText(/支付 1 笔/);
    await user.click(screen.getByRole("button", { name: "退款与退款申请" }));
    await user.selectOptions(screen.getByLabelText("支付单"), [
      capturedPayment.payment_id,
    ]);
    await user.type(screen.getByLabelText("退款金额"), "20.00");
    await user.type(screen.getByLabelText("退款原因"), "保留输入");
    await user.click(screen.getByRole("button", { name: "提交退款" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("支付网关拒绝了退款"),
    );
    expect(screen.getByLabelText("支付单")).toHaveValue(
      capturedPayment.payment_id,
    );
    expect(screen.getByLabelText("退款金额")).toHaveValue("20.00");
    expect(screen.getByLabelText("退款原因")).toHaveValue("保留输入");
    const firstIdempotencyKey = api.createAdminRefund.mock.calls[0]?.[0]
      .idempotencyKey as string;

    await user.clear(screen.getByLabelText("退款金额"));
    await user.type(screen.getByLabelText("退款金额"), "20");
    await user.click(screen.getByRole("button", { name: "提交退款" }));
    await waitFor(() => expect(api.createAdminRefund).toHaveBeenCalledTimes(2));
    expect(api.createAdminRefund.mock.calls[1]?.[0]).toMatchObject({
      amount: "2000",
      idempotencyKey: firstIdempotencyKey,
    });
    expect(api.getPaymentAdminRecords).toHaveBeenCalledTimes(2);
    expect(api.getRefundAdminRecords).toHaveBeenCalledTimes(2);
    expect(api.getInvoiceAdminRecords).toHaveBeenCalledTimes(2);
  });

  it("rejects an over-refund before issuing a request", async () => {
    api.getPaymentAdminRecords.mockResolvedValue([
      { ...capturedPayment, refunded_amount: "11999" },
    ]);
    const onNotice = vi.fn();
    const user = userEvent.setup();

    render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={verifiedTenant}
        onNotice={onNotice}
      />,
    );

    await screen.findByText(/支付 1 笔/);
    await user.click(screen.getByRole("button", { name: "退款与退款申请" }));
    expect(screen.getByRole("option", { name: /剩余 0.01 CNY/ })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("支付单"), [
      capturedPayment.payment_id,
    ]);
    await user.type(screen.getByLabelText("退款金额"), "0.02");
    await user.type(screen.getByLabelText("退款原因"), "超过剩余金额");
    await user.click(screen.getByRole("button", { name: "提交退款" }));

    expect(onNotice).toHaveBeenCalledWith(
      "退款金额必须大于零、符合币种精度，且不得超过剩余可退款金额",
    );
    expect(api.createAdminRefund).not.toHaveBeenCalled();
  });

  it("ignores a superseded completion after the API availability boundary resets", async () => {
    const supersededPayments = deferred<PaymentAdminRecord[]>();
    api.getPaymentAdminRecords
      .mockReturnValueOnce(supersededPayments.promise)
      .mockResolvedValueOnce([capturedPayment]);
    const props = {
      tenant: verifiedTenant,
      onNotice: vi.fn(),
    };
    const { rerender } = render(
      <PlatformFinanceRecordsPanel authorized apiAvailable {...props} />,
    );
    await waitFor(() =>
      expect(api.getPaymentAdminRecords).toHaveBeenCalledTimes(1),
    );

    rerender(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable={false}
        {...props}
      />,
    );
    rerender(
      <PlatformFinanceRecordsPanel authorized apiAvailable {...props} />,
    );

    expect(await screen.findByText(/支付 1 笔/)).toBeInTheDocument();
    await act(async () => {
      supersededPayments.resolve([]);
      await supersededPayments.promise;
    });
    expect(screen.getByText(/支付 1 笔/)).toBeInTheDocument();
    expect(api.getPaymentAdminRecords).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an unverified tenant from verified missing initialization", async () => {
    api.getPaymentAdminRecords.mockResolvedValue([capturedPayment]);
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const { rerender } = render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={{ status: "unverified" }}
        onNotice={onNotice}
      />,
    );

    await screen.findByText(/支付 1 笔/);
    await user.click(screen.getByRole("button", { name: "退款与退款申请" }));

    expect(
      screen.getByText(/商城租户状态尚未验证，退款操作已暂停/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/商城已确认尚未完成初始化/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交退款" }),
    ).not.toBeInTheDocument();

    rerender(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable
        tenant={{ status: "verified", tenantId: null }}
        onNotice={onNotice}
      />,
    );
    expect(
      screen.getByText(/商城已确认尚未完成初始化，暂时不能提交退款/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/商城租户状态尚未验证/)).not.toBeInTheDocument();
  });

  it("shows authorization-required without issuing record requests", () => {
    render(
      <PlatformFinanceRecordsPanel
        authorized={false}
        apiAvailable
        tenant={verifiedTenant}
        onNotice={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "需要商城负责人或管理员权限",
    );
    expect(screen.queryByText(/未启用平台 API/)).not.toBeInTheDocument();
    expect(api.getPaymentAdminRecords).not.toHaveBeenCalled();
    expect(api.getRefundAdminRecords).not.toHaveBeenCalled();
    expect(api.getInvoiceAdminRecords).not.toHaveBeenCalled();
  });

  it("shows API-disabled as unavailable without issuing record requests", () => {
    render(
      <PlatformFinanceRecordsPanel
        authorized
        apiAvailable={false}
        tenant={verifiedTenant}
        onNotice={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "当前部署未启用平台 API",
    );
    expect(api.getPaymentAdminRecords).not.toHaveBeenCalled();
    expect(api.getRefundAdminRecords).not.toHaveBeenCalled();
    expect(api.getInvoiceAdminRecords).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
