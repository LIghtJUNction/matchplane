import type { PaymentAdminRecord } from "../api";

const MAX_CURRENCY_SCALE = 28;
const MAX_AMOUNT_TEXT_LENGTH = 128;

export function parseMoneyMinorUnits(
  value: string,
  currencyScale: number,
): bigint | null {
  if (
    !Number.isInteger(currencyScale) ||
    currencyScale < 0 ||
    currencyScale > MAX_CURRENCY_SCALE
  ) {
    return null;
  }

  const text = value.trim();
  if (text.length === 0 || text.length > MAX_AMOUNT_TEXT_LENGTH) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;

  const fraction = match[2] ?? "";
  if (fraction.length > currencyScale) return null;
  return BigInt(`${match[1]}${fraction.padEnd(currencyScale, "0")}`);
}

export function remainingRefundAmount(
  payment: PaymentAdminRecord,
): string | null {
  const captured = parseMoneyMinorUnits(
    payment.captured_amount,
    payment.currency_scale,
  );
  const refunded = parseMoneyMinorUnits(
    payment.refunded_amount,
    payment.currency_scale,
  );
  if (captured === null || refunded === null || refunded > captured) return null;
  return formatMoneyMinorUnits(captured - refunded, payment.currency_scale);
}

export function isRefundablePayment(payment: PaymentAdminRecord): boolean {
  if (payment.status !== "captured") return false;
  const remaining = remainingRefundMinorUnits(payment);
  return remaining !== null && remaining > 0n;
}

export function isRefundAmountWithinRemaining(
  payment: PaymentAdminRecord,
  amount: string,
): boolean {
  const requested = parseMoneyMinorUnits(amount, payment.currency_scale);
  const remaining = remainingRefundMinorUnits(payment);
  return requested !== null && requested > 0n && remaining !== null && requested <= remaining;
}

function remainingRefundMinorUnits(payment: PaymentAdminRecord): bigint | null {
  const captured = parseMoneyMinorUnits(
    payment.captured_amount,
    payment.currency_scale,
  );
  const refunded = parseMoneyMinorUnits(
    payment.refunded_amount,
    payment.currency_scale,
  );
  if (captured === null || refunded === null || refunded > captured) return null;
  return captured - refunded;
}

function formatMoneyMinorUnits(value: bigint, currencyScale: number): string {
  if (currencyScale === 0) return value.toString();
  const digits = value.toString().padStart(currencyScale + 1, "0");
  return `${digits.slice(0, -currencyScale)}.${digits.slice(-currencyScale)}`;
}
