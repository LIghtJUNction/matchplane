import { describe, expect, it } from "vitest";

import {
  serializeSupplyFieldValues,
  supplyFieldValuesFromAttributes,
  withoutSupplyFieldAttributes,
  type SupplyFieldConfig,
} from "./supply-fields";

const fields = [
  { key: "brand", label: "品牌", required: true },
  {
    key: "mileage_km",
    label: "表显里程",
    type: "number",
    min: 0,
    max: 1_000_000,
  },
  { key: "source_url", label: "来源链接", type: "url" },
  { key: "registered_on", label: "上牌日期", type: "date" },
] satisfies readonly SupplyFieldConfig[];

describe("supply-field attribute helpers", () => {
  it("loads declared string and finite number values", () => {
    expect(
      supplyFieldValuesFromAttributes(fields, {
        brand: "雪佛兰",
        mileage_km: 42000,
        source_url: null,
        registered_on: true,
        opaque: { retained: true },
      }),
    ).toEqual({
      brand: "雪佛兰",
      mileage_km: "42000",
      source_url: "",
      registered_on: "",
    });
  });

  it("preserves domain-neutral opaque attributes while removing declared and authority keys", () => {
    expect(
      withoutSupplyFieldAttributes(fields, {
        brand: "雪佛兰",
        mileage_km: 42000,
        opaque: { retained: true },
        legacy_rank: 7,
        vin: "domain-owned-value",
        supplier_id: "private-supplier",
      }),
    ).toEqual({
      opaque: { retained: true },
      legacy_rank: 7,
      vin: "domain-owned-value",
    });
  });

  it("serializes trimmed strings and finite numbers", () => {
    expect(
      serializeSupplyFieldValues(fields, {
        brand: "  雪佛兰  ",
        mileage_km: " 42000.5 ",
        source_url: " https://example.test/cars/1 ",
        registered_on: "2024-02-29",
      }),
    ).toEqual({
      attributes: {
        brand: "雪佛兰",
        mileage_km: 42000.5,
        source_url: "https://example.test/cars/1",
        registered_on: "2024-02-29",
      },
      error: null,
    });
  });

  it("omits cleared optional fields so edits can delete declared attributes", () => {
    const opaque = withoutSupplyFieldAttributes(fields, {
      brand: "旧品牌",
      mileage_km: 100,
      source_url: "https://old.example.test",
      integration_payload: { untouched: true },
    });
    const serialized = serializeSupplyFieldValues(fields, {
      brand: "新品牌",
      mileage_km: "",
      source_url: "   ",
      registered_on: "",
    });

    expect({ ...opaque, ...serialized.attributes }).toEqual({
      brand: "新品牌",
      integration_payload: { untouched: true },
    });
  });

  it.each([
    [{ brand: " " }, { key: "brand", label: "品牌", reason: "required" }],
    [
      { brand: "A", mileage_km: "Infinity" },
      { key: "mileage_km", label: "表显里程", reason: "number" },
    ],
    [
      { brand: "A", mileage_km: "-1" },
      { key: "mileage_km", label: "表显里程", reason: "min" },
    ],
    [
      { brand: "A", mileage_km: "1000001" },
      { key: "mileage_km", label: "表显里程", reason: "max" },
    ],
    [
      { brand: "A", source_url: "ftp://example.test/car" },
      { key: "source_url", label: "来源链接", reason: "url" },
    ],
    [
      { brand: "A", registered_on: "2023-02-29" },
      { key: "registered_on", label: "上牌日期", reason: "date" },
    ],
    [
      { brand: "A", registered_on: "30-08-2026" },
      { key: "registered_on", label: "上牌日期", reason: "date" },
    ],
  ] as const)("reports the first validation failure for %o", (values, error) => {
    expect(serializeSupplyFieldValues(fields, values).error).toEqual(error);
  });

  it("rejects values outside declared select options and numeric steps", () => {
    expect(
      serializeSupplyFieldValues(
        [
          {
            key: "energy",
            label: "能源",
            type: "select",
            options: ["汽油", "纯电"],
          },
        ],
        { energy: "氢能" },
      ).error,
    ).toEqual({ key: "energy", label: "能源", reason: "option" });
    expect(
      serializeSupplyFieldValues(
        [
          {
            key: "mileage_km",
            label: "里程",
            type: "number",
            min: 100,
            step: 50,
          },
        ],
        { mileage_km: "125" },
      ).error,
    ).toEqual({ key: "mileage_km", label: "里程", reason: "step" });
  });

  it("accepts only credential-free HTTP and HTTPS URLs", () => {
    expect(
      serializeSupplyFieldValues(fields, {
        brand: "A",
        source_url: "http://example.test/car",
      }).error,
    ).toBeNull();
    expect(
      serializeSupplyFieldValues(fields, {
        brand: "A",
        source_url: "https://example.test/car",
      }).error,
    ).toBeNull();
    expect(
      serializeSupplyFieldValues(fields, {
        brand: "A",
        source_url: "https://user:secret@example.test/car",
      }).error,
    ).toEqual({ key: "source_url", label: "来源链接", reason: "url" });
  });
});
