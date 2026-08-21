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
  const currency = typeof terms.currency === "string" ? terms.currency : null;
  if (intent.budget?.currency && currency && intent.budget.currency !== currency) {
    return { eligible: false, boost: 0, reasons: [] };
  }
  if (intent.budget?.minimum !== undefined || intent.budget?.maximum !== undefined) {
    if (amount === null) return { eligible: false, boost: 0, reasons: [] };
    if (intent.budget.minimum !== undefined && amount < intent.budget.minimum) return { eligible: false, boost: 0, reasons: [] };
    if (intent.budget.maximum !== undefined && amount > intent.budget.maximum) return { eligible: false, boost: 0, reasons: [] };
    boost += 0.24;
    reasons.push("价格符合预算");
  }

  const allValues = Object.values(attributes).filter(isPrimitive).map(normalizedValue);
  for (const requirement of intent.requirements.slice(0, 16)) {
    const values = requirement.field && Object.hasOwn(attributes, requirement.field)
      ? [normalizedValue(attributes[requirement.field])]
      : allValues;
    const matched = values.some((candidate) => matchesRequirement(candidate, requirement.value, requirement.operator));
    if (requirement.mode === "exclude" && matched) return { eligible: false, boost: 0, reasons: [] };
    if (requirement.mode === "must" && !matched) return { eligible: false, boost: 0, reasons: [] };
    if (matched) {
      boost += requirement.mode === "must" ? 0.16 : 0.08;
      reasons.push(requirement.field ? `${requirement.field} 符合 ${requirement.value}` : `符合 ${requirement.value}`);
    }
  }
  return { eligible: true, boost: Math.min(0.7, boost), reasons: reasons.slice(0, 8) };
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
