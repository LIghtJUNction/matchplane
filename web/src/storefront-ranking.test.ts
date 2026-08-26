import { describe, expect, it } from "vitest";

import { rankPublicStorefrontCandidates } from "./storefront-ranking";

const candidate = {
  row: { id: "offer-1" },
  displayName: "轻便旅行相机",
  attributes: {
    description: "金属机身，适合旅行拍摄",
    material: "金属",
  },
  terms: {
    currency: "CNY",
  },
};

describe("public storefront structured ranking", () => {
  it("keeps a currency-only exact canonical match explainable", () => {
    const ranked = rankPublicStorefrontCandidates([candidate], "", {
      budget: { currency: "CNY" },
      requirements: [],
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      score: 0.08,
      intentReasons: ["币种符合 CNY"],
    });
  });

  it("keeps a satisfied exclusion-only match explainable", () => {
    const ranked = rankPublicStorefrontCandidates([candidate], "", {
      requirements: [
        {
          field: "material",
          value: "塑料",
          mode: "exclude",
          operator: "contains",
        },
      ],
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      score: 0.08,
      intentReasons: ["公开属性 material 未命中排除项：塑料"],
    });
  });
});
