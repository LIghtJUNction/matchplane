import { describe, expect, it } from "vitest";

import {
  validateManifestProductTemplates,
  validateManifestUi,
} from "./manifest-ui-validation";

const validUi = {
  chat: { buyerPlaceholder: "描述需求" },
  copy: { emptyTitle: "暂无商品" },
  filters: [
    {
      key: "verified",
      label: "已验证",
      source: "trust",
      value: "yes",
    },
    {
      key: "brand",
      label: "品牌",
      source: "attribute",
      attribute: "vehicle.brand",
    },
  ],
  supplyFields: [
    {
      key: "vehicle.brand",
      label: "品牌",
      type: "select",
      required: true,
      placeholder: "选择品牌",
      options: ["甲", "乙"],
      group: "车辆识别",
      help: "选择对买家公开的车辆品牌。",
    },
    {
      key: "vehicle.condition_summary",
      label: "公开车况摘要",
      type: "textarea",
      group: "车况",
      help: "只填写可公开的信息。",
    },
    {
      key: "vehicle.mileage_km",
      label: "表显里程",
      type: "number",
      group: "车辆识别",
      unit: "km",
      min: 0,
      max: 10_000_000,
      step: 100,
    },
  ],
};

describe("validateManifestUi", () => {
  it("accepts the supported UI contract", () => {
    expect(validateManifestUi({})).toBe(true);
    expect(validateManifestUi(validUi)).toBe(true);
  });

  it.each([
    null,
    [],
    "ui",
    { unknown: true },
  ])("rejects an invalid root value %#", (value) => {
    expect(validateManifestUi(value)).toBe(false);
  });

  it("enforces bounded chat and copy dictionaries", () => {
    expect(validateManifestUi({ chat: { "not a key": "copy" } })).toBe(false);
    expect(validateManifestUi({ copy: { valid: "x".repeat(501) } })).toBe(
      false,
    );
    expect(
      validateManifestUi({
        chat: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`key${index}`, "copy"]),
        ),
      }),
    ).toBe(false);
  });

  it("rejects invalid filter fields and limits", () => {
    expect(
      validateManifestUi({
        filters: [{ key: "brand", label: "品牌", source: "unknown" }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        filters: Array.from({ length: 33 }, (_, index) => ({
          key: `key${index}`,
          label: "字段",
          source: "price",
        })),
      }),
    ).toBe(false);
  });

  it("accepts bounded public vehicle metadata", () => {
    expect(validateManifestUi(validUi)).toBe(true);
    expect(
      validateManifestUi({
        supplyFields: [
          { key: "registration_date", label: "上牌年月", type: "date" },
          { key: "engine_displacement_l", label: "排量", unit: "L" },
          { key: "inspection_summary", label: "检测摘要", type: "textarea" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects duplicate supply keys and invalid numeric bounds", () => {
    expect(
      validateManifestUi({
        supplyFields: [
          { key: "vehicle.brand", label: "品牌" },
          { key: "vehicle.brand", label: "品牌（重复）" },
        ],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [{ key: "mileage_km", label: "里程", min: 10, max: 5 }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [{ key: "mileage_km", label: "里程", step: 0 }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [
          { key: "mileage_km", label: "里程", max: 1_000_000_000_000_001 },
        ],
      }),
    ).toBe(false);
  });

  it("rejects domain-neutral private attributes in the public supply contract", () => {
    for (const key of [
      "supplier_phone",
      "contact_email",
      "api_credential",
      "purchase_price",
      "operating_cost",
      "profit_margin",
      "exact_location",
      "warehouse_slot",
      "internal_notes",
    ]) {
      expect(
        validateManifestUi({ supplyFields: [{ key, label: "敏感字段" }] }),
        key,
      ).toBe(false);
    }
    expect(
      validateManifestUi({ supplyFields: [{ key: "vin", label: "VIN" }] }),
    ).toBe(true);
  });

  it("rejects invalid supply-field options and scalar types", () => {
    expect(
      validateManifestUi({
        supplyFields: [{ key: "price", label: "价格", type: "currency" }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [{ key: "brand", label: "品牌", type: "select" }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [
          { key: "brand", label: "品牌", type: "text", options: ["甲"] },
        ],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [
          {
            key: "brand",
            label: "品牌",
            type: "select",
            options: ["甲", " 甲 "],
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [
          { key: "mileage_km", label: "里程", type: "text", min: 0 },
        ],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [{ key: "brand", label: "品牌", required: "yes" }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [{ key: "brand", label: "品牌", options: [""] }],
      }),
    ).toBe(false);
    expect(
      validateManifestUi({
        supplyFields: [
          { key: "brand", label: "品牌", options: ["x".repeat(201)] },
        ],
      }),
    ).toBe(false);
  });

  it.each([
    { group: "x".repeat(121) },
    { help: "x".repeat(501) },
    { unit: "x".repeat(41) },
  ])("bounds supply-field display metadata %#", (metadata) => {
    expect(
      validateManifestUi({
        supplyFields: [{ key: "mileage_km", label: "里程", ...metadata }],
      }),
    ).toBe(false);
  });

  it("rejects package-owned contact fields so contact stays account-verified", () => {
    expect(
      validateManifestUi({
        contactFields: [{ key: "phone", label: "电话", type: "tel" }],
      }),
    ).toBe(false);
  });
});

describe("validateManifestProductTemplates", () => {
  const template = (id: string, key = `${id}_field`) => ({
    id,
    label: id,
    supplyFields: [{ key, label: key }],
  });

  it("accepts absent templates, one implicit default, and a declared default", () => {
    expect(validateManifestProductTemplates({})).toBe(true);
    expect(
      validateManifestProductTemplates({ productTemplates: [template("one")] }),
    ).toBe(true);
    expect(
      validateManifestProductTemplates({
        productTemplates: [template("one"), template("two")],
        defaultProductTemplateId: "two",
      }),
    ).toBe(true);
  });

  it("rejects missing defaults, duplicates, ambiguous legacy, and conflicting shared fields", () => {
    expect(
      validateManifestProductTemplates({
        productTemplates: [template("one"), template("two")],
      }),
    ).toBe(false);
    expect(
      validateManifestProductTemplates({
        productTemplates: [template("one"), template("one")],
      }),
    ).toBe(false);
    expect(
      validateManifestProductTemplates({
        ui: { supplyFields: [] },
        productTemplates: [template("one")],
      }),
    ).toBe(false);
    expect(
      validateManifestProductTemplates({
        productTemplates: [
          template("one", "shared"),
          {
            id: "two",
            label: "two",
            supplyFields: [{ key: "shared", label: "Different" }],
          },
        ],
        defaultProductTemplateId: "one",
      }),
    ).toBe(false);
  });
});
