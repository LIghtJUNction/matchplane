import { describe, expect, it } from "vitest";

import {
  evaluateShoppingIntent,
  type PublicShoppingIntent,
} from "./shopping-intent";

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

  it("treats only an exact canonical currency as a positive currency-only fit", () => {
    const intent: PublicShoppingIntent = {
      budget: { currency: "CNY" },
      requirements: [],
    };
    const matched = evaluateShoppingIntent(
      {},
      { currency: "CNY" },
      intent,
    );

    expect(matched).toEqual({
      eligible: true,
      boost: 0.08,
      reasons: ["币种符合 CNY"],
    });
    expect(evaluateShoppingIntent({}, {}, intent).eligible).toBe(false);
    expect(
      evaluateShoppingIntent({}, { currency: "cny" }, intent).eligible,
    ).toBe(false);
    expect(
      evaluateShoppingIntent({}, { currency: "USD" }, intent).eligible,
    ).toBe(false);
  });

  it("explains a satisfied exclusion-only fit", () => {
    const result = evaluateShoppingIntent(
      { material: "金属", condition: "全新" },
      { currency: "CNY" },
      {
        requirements: [
          {
            field: "material",
            value: "塑料",
            mode: "exclude",
            operator: "contains",
          },
        ],
      },
    );

    expect(result).toEqual({
      eligible: true,
      boost: 0.08,
      reasons: ["公开属性 material 未命中排除项：塑料"],
    });
  });

  it("fails closed for absent or unusable explicit hard fields", () => {
    const terms = { currency: "CNY" };
    const missingMust = evaluateShoppingIntent(
      { description: "金属材质" },
      terms,
      {
        requirements: [
          { field: "material", value: "金属", mode: "must", operator: "eq" },
        ],
      },
    );
    const missingExclude = evaluateShoppingIntent({}, terms, {
      requirements: [
        {
          field: "material",
          value: "塑料",
          mode: "exclude",
          operator: "contains",
        },
      ],
    });
    const unusableExclude = evaluateShoppingIntent(
      { material: { label: "金属" } },
      terms,
      {
        requirements: [
          {
            field: "material",
            value: "塑料",
            mode: "exclude",
            operator: "contains",
          },
        ],
      },
    );
    const missingPrefer = evaluateShoppingIntent({}, terms, {
      requirements: [
        {
          field: "material",
          value: "金属",
          mode: "prefer",
          operator: "eq",
        },
      ],
    });

    expect(missingMust.eligible).toBe(false);
    expect(missingExclude.eligible).toBe(false);
    expect(unusableExclude.eligible).toBe(false);
    expect(missingPrefer).toEqual({ eligible: true, boost: 0, reasons: [] });
  });

  it("scopes a fieldless exclusion reason to public attributes", () => {
    const result = evaluateShoppingIntent(
      { material: "金属", condition: "全新" },
      { currency: "CNY" },
      {
        requirements: [
          { value: "塑料", mode: "exclude", operator: "contains" },
        ],
      },
    );

    expect(result).toEqual({
      eligible: true,
      boost: 0.08,
      reasons: ["公开属性未命中排除项：塑料"],
    });
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
