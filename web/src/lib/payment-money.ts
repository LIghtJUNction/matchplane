import type { PaymentAdminRecord } from "../api";

const MAX_CURRENCY_SCALE = 18;
const MAX_MINOR_UNIT_DIGITS = 38;
const MAX_AMOUNT_TEXT_LENGTH = 128;

/** Parse a user-facing major-unit amount into the payment API's integer minor units. */
export function parseMoneyMinorUnits(
  value: string,
  currencyScale: number,
): bigint | null {
  if (!isValidCurrencyScale(currencyScale)) return null;

  const text = value.trim();
  if (text.length === 0 || text.length > MAX_AMOUNT_TEXT_LENGTH) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;

  const fraction = match[2] ?? "";
  if (fraction.length > currencyScale) return null;
  return parseMinorUnitDigits(
    `${match[1]}${fraction.padEnd(currencyScale, "0")}`,
  );
}

/** Format the payment API's integer minor-unit representation for people. */
export function formatStoredMoneyAmount(
  value: string,
  currencyScale: number,
): string | null {
  if (!isValidCurrencyScale(currencyScale)) return null;
  const minorUnits = parseStoredMinorUnits(value);
  return minorUnits === null
    ? null
    : formatMoneyMinorUnits(minorUnits, currencyScale);
}

export function remainingRefundAmount(
  payment: PaymentAdminRecord,
): string | null {
  const remaining = remainingRefundMinorUnits(payment);
  return remaining === null
    ? null
    : formatMoneyMinorUnits(remaining, payment.currency_scale);
}

export function isRefundablePayment(payment: PaymentAdminRecord): boolean {
  if (payment.status !== "captured") return false;
  const remaining = remainingRefundMinorUnits(payment);
  return remaining !== null && remaining > 0n;
}

export function refundAmountMinorUnits(
  payment: PaymentAdminRecord,
  amount: string,
): string | null {
  const requested = parseMoneyMinorUnits(amount, payment.currency_scale);
  const remaining = remainingRefundMinorUnits(payment);
  return requested !== null &&
    requested > 0n &&
    remaining !== null &&
    requested <= remaining
    ? requested.toString()
    : null;
}

export function isRefundAmountWithinRemaining(
  payment: PaymentAdminRecord,
  amount: string,
): boolean {
  return refundAmountMinorUnits(payment, amount) !== null;
}

function remainingRefundMinorUnits(payment: PaymentAdminRecord): bigint | null {
  if (!isValidCurrencyScale(payment.currency_scale)) return null;
  const captured = parseStoredMinorUnits(payment.captured_amount);
  const refunded = parseStoredMinorUnits(payment.refunded_amount);
  if (captured === null || refunded === null || refunded > captured)
    return null;
  return captured - refunded;
}

function parseStoredMinorUnits(value: string): bigint | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  return parseMinorUnitDigits(text);
}

function parseMinorUnitDigits(value: string): bigint | null {
  const normalized = value.replace(/^0+(?=\d)/, "");
  if (normalized.length === 0 || normalized.length > MAX_MINOR_UNIT_DIGITS) {
    return null;
  }
  return BigInt(normalized);
}

function isValidCurrencyScale(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CURRENCY_SCALE;
}

function formatMoneyMinorUnits(value: bigint, currencyScale: number): string {
  if (currencyScale === 0) return value.toString();
  const digits = value.toString().padStart(currencyScale + 1, "0");
  return `${digits.slice(0, -currencyScale)}.${digits.slice(-currencyScale)}`;
}
