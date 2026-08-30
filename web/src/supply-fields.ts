import { isSafePublicAttributeKey } from "./storefront-ranking-shared";
import type { SupplyFieldConfig } from "./subplatform";

export type { SupplyFieldConfig, SupplyFieldType } from "./subplatform";

type SupplyFieldSerializationError = {
  key: string;
  label: string;
  reason:
    | "required"
    | "number"
    | "min"
    | "max"
    | "step"
    | "option"
    | "url"
    | "date";
};

export type SupplyFieldSerializationResult = {
  attributes: Record<string, string | number>;
  error: SupplyFieldSerializationError | null;
};

/**
 * Read the manifest-declared values from an existing offer. Unknown attributes
 * intentionally stay outside this map so callers can preserve them separately.
 */
export function supplyFieldValuesFromAttributes(
  fields: readonly SupplyFieldConfig[],
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = attributes?.[field.key];
    values[field.key] =
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
        ? String(value)
        : "";
  }
  return values;
}

/** Return a shallow copy without any manifest-declared attribute keys. */
export function withoutSupplyFieldAttributes(
  fields: readonly SupplyFieldConfig[],
  attributes: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> {
  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (isSafePublicAttributeKey(key)) remaining[key] = value;
  }
  for (const field of fields) delete remaining[field.key];
  return remaining;
}

type SerializedFieldValue =
  | { state: "empty" }
  | { state: "valid"; value: string | number }
  | { state: "invalid"; reason: SupplyFieldSerializationError["reason"] };

/** Validate and serialize manifest-driven form values in declaration order. */
export function serializeSupplyFieldValues(
  fields: readonly SupplyFieldConfig[],
  values: Readonly<Record<string, string>>,
): SupplyFieldSerializationResult {
  const attributes: Record<string, string | number> = {};

  for (const field of fields) {
    const serialized = serializeFieldValue(
      field,
      (values[field.key] ?? "").trim(),
    );
    if (serialized.state === "empty") {
      if (field.required) {
        return { attributes, error: fieldError(field, "required") };
      }
      continue;
    }
    if (serialized.state === "invalid") {
      return { attributes, error: fieldError(field, serialized.reason) };
    }
    attributes[field.key] = serialized.value;
  }

  return { attributes, error: null };
}

function serializeFieldValue(
  field: SupplyFieldConfig,
  value: string,
): SerializedFieldValue {
  if (!value) return { state: "empty" };
  switch (field.type) {
    case "number":
      return serializeNumber(field, value);
    case "select":
      return field.options?.includes(value)
        ? { state: "valid", value }
        : { state: "invalid", reason: "option" };
    case "url":
      return isHttpUrl(value)
        ? { state: "valid", value }
        : { state: "invalid", reason: "url" };
    case "date":
      return isCalendarDate(value)
        ? { state: "valid", value }
        : { state: "invalid", reason: "date" };
    default:
      return { state: "valid", value };
  }
}

function serializeNumber(
  field: SupplyFieldConfig,
  value: string,
): SerializedFieldValue {
  const number = Number(value);
  if (!Number.isFinite(number)) return { state: "invalid", reason: "number" };
  if (field.min !== undefined && number < field.min) {
    return { state: "invalid", reason: "min" };
  }
  if (field.max !== undefined && number > field.max) {
    return { state: "invalid", reason: "max" };
  }
  if (
    field.step !== undefined &&
    !isStepAligned(number, field.min ?? 0, field.step)
  ) {
    return { state: "invalid", reason: "step" };
  }
  return { state: "valid", value: number };
}

function fieldError(
  field: SupplyFieldConfig,
  reason: SupplyFieldSerializationError["reason"],
): SupplyFieldSerializationError {
  return { key: field.key, label: field.label, reason };
}

function isStepAligned(value: number, base: number, step: number): boolean {
  const steps = (value - base) / step;
  const tolerance = Number.EPSILON * Math.max(16, Math.abs(steps) * 16);
  return Math.abs(steps - Math.round(steps)) <= tolerance;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day <= maximumDay;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
