import { describe, expect, it } from "vitest";

import { evaluateShoppingIntent } from "./shopping-intent";

describe("public shopping intent", () => {
  it("enforces explicit budget and must-have attributes without knowing a product category", () => {
    const result = evaluateShoppingIntent(
      { maker: "Example", energy: "纯电", year: 2022, mileage: 32000 },
      { amount_minor: "8800000", currency: "CNY", currency_scale: 2 },
      {
        budget: { maximum: 100000, currency: "CNY" },
        requirements: [
          { field: "energy", value: "纯电", mode: "must", operator: "eq" },
          { field: "year", value: "2020", mode: "must", operator: "gte" },
          { field: "mileage", value: "50000", mode: "must", operator: "lte" },
        ],
      },
    );

    expect(result.eligible).toBe(true);
    expect(result.boost).toBeGreaterThan(0.5);
    expect(result.reasons).toContain("价格符合预算");
  });

  it("rejects products outside a must-have constraint or an exclusion", () => {
    expect(evaluateShoppingIntent(
      { material: "塑料", condition: "二手" },
      { amount_minor: "10000", currency: "CNY", currency_scale: 2 },
      {
        requirements: [
          { field: "condition", value: "全新", mode: "must", operator: "eq" },
        ],
      },
    ).eligible).toBe(false);

    expect(evaluateShoppingIntent(
      { material: "塑料" },
      { amount_minor: "10000", currency: "CNY", currency_scale: 2 },
      {
        requirements: [
          { field: "material", value: "塑料", mode: "exclude", operator: "contains" },
        ],
      },
    ).eligible).toBe(false);
  });
});
