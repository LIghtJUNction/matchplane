import type { PublicShoppingIntent } from "./shopping-intent";

export const SHOPPING_MEMORY_FACT_KINDS = [
  "budget",
  "purpose",
  "preference",
  "exclusion",
] as const;

export type ShoppingMemoryFactKind =
  (typeof SHOPPING_MEMORY_FACT_KINDS)[number];

/** A customer-authored shopping default. Values are intentionally small and domain-neutral. */
export interface ShoppingMemoryFact {
  kind: ShoppingMemoryFactKind;
  key: string;
  value: string;
  currency?: string;
}

export interface ShoppingMemorySnapshot {
  enabled: boolean;
  facts: ShoppingMemoryFact[];
  version: number;
  updatedAt: string | null;
}

export interface ShoppingMemoryMutation {
  enabled: boolean;
  facts: ShoppingMemoryFact[];
  expectedVersion: number;
}

/** Apply only explicit numeric budget defaults to deterministic retrieval. */
export function shoppingMemoryIntent(
  memory: ShoppingMemorySnapshot | null | undefined,
): PublicShoppingIntent {
  if (!memory?.enabled) return { requirements: [] };
  const maximum = memory.facts.find(
    (fact) => fact.kind === "budget" && fact.key === "maximum",
  );
  const amount = maximum ? Number(maximum.value) : Number.NaN;
  return {
    ...(Number.isFinite(amount) && amount > 0
      ? {
          budget: {
            maximum: amount,
            currency: maximum?.currency ?? "CNY",
          },
        }
      : {}),
    requirements: [],
  };
}

export function memoryFactsForModel(
  memory: ShoppingMemorySnapshot | null | undefined,
): ShoppingMemoryFact[] {
  return memory?.enabled ? memory.facts.slice(0, 16) : [];
}
