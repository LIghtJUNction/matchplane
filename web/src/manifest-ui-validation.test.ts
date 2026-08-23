import { describe, expect, it } from "vitest";

import { validateManifestUi } from "./manifest-ui-validation";

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

  it("rejects invalid supply-field options and scalar types", () => {
    expect(
      validateManifestUi({
        supplyFields: [{ key: "price", label: "价格", type: "currency" }],
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
  });

  it("rejects package-owned contact fields so contact stays account-verified", () => {
    expect(
      validateManifestUi({
        contactFields: [{ key: "phone", label: "电话", type: "tel" }],
      }),
    ).toBe(false);
  });
});
