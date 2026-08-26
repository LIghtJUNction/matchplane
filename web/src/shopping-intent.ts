export type ShoppingRequirementMode = "must" | "prefer" | "exclude";
export type ShoppingRequirementOperator = "contains" | "eq" | "gte" | "lte";

export interface ShoppingIntentRequirement {
  field?: string;
  value: string;
  mode: ShoppingRequirementMode;
  operator: ShoppingRequirementOperator;
}

export interface PublicShoppingIntent {
  budget?: {
    minimum?: number;
    maximum?: number;
    currency?: string;
  };
  requirements: ShoppingIntentRequirement[];
}

export interface ShoppingIntentEvaluation {
  eligible: boolean;
  boost: number;
  reasons: string[];
}

const MAX_INTENT_REASONS = 8;
const MAX_INTENT_REASON_CHARACTERS = 500;

/** Apply model-extracted intent only to canonical public attributes and terms. */
export function evaluateShoppingIntent(
  attributes: Record<string, unknown>,
  terms: Record<string, unknown>,
  intent: PublicShoppingIntent | undefined,
): ShoppingIntentEvaluation {
  if (!intent) return { eligible: true, boost: 0, reasons: [] };
  const reasons: string[] = [];
  let boost = 0;
  const amount = majorPrice(terms);
  const requestedCurrency = intent.budget?.currency;
  if (requestedCurrency !== undefined) {
    const canonicalCurrency =
      typeof terms.currency === "string" && /^[A-Z]{3}$/.test(terms.currency)
        ? terms.currency
        : null;
    if (canonicalCurrency === null || requestedCurrency !== canonicalCurrency) {
      return { eligible: false, boost: 0, reasons: [] };
    }
    boost += 0.08;
    addReason(reasons, `币种符合 ${canonicalCurrency}`);
  }
  if (intent.budget?.minimum !== undefined || intent.budget?.maximum !== undefined) {
    if (amount === null) return { eligible: false, boost: 0, reasons: [] };
    if (intent.budget.minimum !== undefined && amount < intent.budget.minimum) return { eligible: false, boost: 0, reasons: [] };
    if (intent.budget.maximum !== undefined && amount > intent.budget.maximum) return { eligible: false, boost: 0, reasons: [] };
    boost += 0.24;
    addReason(reasons, "价格符合预算");
  }

  const allValues = Object.values(attributes).filter(isPrimitive).map(normalizedValue);
  for (const requirement of intent.requirements.slice(0, 16)) {
    const field = requirement.field;
    let values: string[];
    if (field !== undefined) {
      const fieldValue = attributes[field];
      const normalizedFieldValue = isPrimitive(fieldValue)
        ? normalizedValue(fieldValue)
        : "";
      if (!Object.hasOwn(attributes, field) || !normalizedFieldValue) {
        if (requirement.mode === "prefer") continue;
        return { eligible: false, boost: 0, reasons: [] };
      }
      values = [normalizedFieldValue];
    } else {
      values = allValues;
    }
    const matched = values.some((candidate) => matchesRequirement(candidate, requirement.value, requirement.operator));
    if (requirement.mode === "exclude") {
      if (matched) return { eligible: false, boost: 0, reasons: [] };
      if (requirement.value.trim()) {
        boost += 0.08;
        addReason(
          reasons,
          field === undefined
            ? `公开属性未命中排除项：${requirement.value}`
            : `公开属性 ${field} 未命中排除项：${requirement.value}`,
        );
      }
      continue;
    }
    if (requirement.mode === "must" && !matched) return { eligible: false, boost: 0, reasons: [] };
    if (matched) {
      boost += requirement.mode === "must" ? 0.16 : 0.08;
      addReason(
        reasons,
        requirement.field
          ? `${requirement.field} 符合 ${requirement.value}`
          : `符合 ${requirement.value}`,
      );
    }
  }
  return { eligible: true, boost: Math.min(0.7, boost), reasons };
}

function addReason(reasons: string[], value: string): void {
  if (reasons.length >= MAX_INTENT_REASONS) return;
  let reason = value.trim().slice(0, MAX_INTENT_REASON_CHARACTERS);
  const trailingCodeUnit = reason.charCodeAt(reason.length - 1);
  if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
    reason = reason.slice(0, -1);
  }
  if (reason) reasons.push(reason);
}

function majorPrice(terms: Record<string, unknown>): number | null {
  const amount = terms.amount_minor;
  const scale = terms.currency_scale;
  if (typeof amount !== "string" || !/^[0-9]{1,38}$/.test(amount) || typeof scale !== "number" || !Number.isSafeInteger(scale)) return null;
  const numeric = Number(amount);
  return Number.isSafeInteger(numeric) ? numeric / (10 ** scale) : null;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizedValue(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function matchesRequirement(candidate: string, expectedValue: string, operator: ShoppingRequirementOperator): boolean {
  const expected = expectedValue.trim().toLocaleLowerCase();
  if (!expected) return false;
  if (operator === "contains") return candidate.includes(expected);
  if (operator === "eq") return candidate === expected;
  const left = Number(candidate.replaceAll(",", ""));
  const right = Number(expected.replaceAll(",", ""));
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return operator === "gte" ? left >= right : left <= right;
}
