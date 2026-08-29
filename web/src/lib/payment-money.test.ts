import { describe, expect, it } from "vitest";

import type { PaymentAdminRecord } from "../api";
import {
  formatStoredMoneyAmount,
  isRefundablePayment,
  isRefundAmountWithinRemaining,
  parseMoneyMinorUnits,
  refundAmountMinorUnits,
  remainingRefundAmount,
} from "./payment-money";

function payment(
  capturedAmount: string,
  refundedAmount: string,
  currencyScale = 2,
): PaymentAdminRecord {
  return {
    payment_id: "payment-1",
    tenant_id: "tenant-1",
    gateway_id: "gateway-1",
    merchant_order_id: "order-1",
    transaction_channel: "marketplace",
    purpose: "purchase",
    gateway_kind: "test",
    gateway_mode: "test",
    payment_method: "test",
    amount: capturedAmount,
    captured_amount: capturedAmount,
    refunded_amount: refundedAmount,
    commission_amount: "0",
    commission_refunded_amount: "0",
    currency: "USD",
    currency_scale: currencyScale,
    status: "captured",
    provider_status: "captured",
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z",
  };
}

describe("payment money invariants", () => {
  it("compares integer minor-unit records exactly beyond Number precision", () => {
    const record = payment("900719925474099301", "2");

    expect(remainingRefundAmount(record)).toBe("9007199254740992.99");
    expect(isRefundAmountWithinRemaining(record, "9007199254740992.99")).toBe(
      true,
    );
    expect(isRefundAmountWithinRemaining(record, "9007199254740993.00")).toBe(
      false,
    );
  });

  it("converts a validated major-unit refund to the API's integer minor units", () => {
    const record = payment("12000", "0");

    expect(refundAmountMinorUnits(record, "20.00")).toBe("2000");
    expect(formatStoredMoneyAmount(record.captured_amount, 2)).toBe("120.00");
    expect(formatStoredMoneyAmount("120.00", 2)).toBeNull();
  });

  it("rejects zero, negative, over-precision, and over-refund requests", () => {
    const record = payment("1000", "325");

    expect(remainingRefundAmount(record)).toBe("6.75");
    expect(isRefundAmountWithinRemaining(record, "0")).toBe(false);
    expect(isRefundAmountWithinRemaining(record, "-1.00")).toBe(false);
    expect(isRefundAmountWithinRemaining(record, "1.001")).toBe(false);
    expect(isRefundAmountWithinRemaining(record, "6.76")).toBe(false);
    expect(isRefundAmountWithinRemaining(record, "6.75")).toBe(true);
  });

  it("removes fully refunded and malformed captured records from eligibility", () => {
    expect(isRefundablePayment(payment("1000", "1000"))).toBe(false);
    expect(isRefundablePayment(payment("1000", "1001"))).toBe(false);
    expect(isRefundablePayment(payment("10.00", "0"))).toBe(false);
  });

  it("enforces the stored currency scale and i128-compatible digit bound", () => {
    expect(parseMoneyMinorUnits("12", 0)).toBe(12n);
    expect(parseMoneyMinorUnits("12.1", 0)).toBeNull();
    expect(parseMoneyMinorUnits("12.345", 3)).toBe(12345n);
    expect(parseMoneyMinorUnits("12.345", 19)).toBeNull();
    expect(parseMoneyMinorUnits("1".repeat(39), 0)).toBeNull();
  });
});
