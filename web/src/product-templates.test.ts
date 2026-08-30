import { describe, expect, it } from "vitest";

import {
  defaultProductTemplate,
  MAX_PRODUCT_TEMPLATE_DESCRIPTION_LENGTH,
  parseProductTemplateCatalog,
  parseProductTemplates,
  productTemplateSwitchImpact,
  supplyFieldDefinitionsEqual,
  supplyFieldsForProductTemplate,
} from "./product-templates";

const field = (key: string, label = key) => ({ key, label });
const template = (
  id: string,
  supplyFields: Array<Record<string, unknown>> = [field(`${id}_field`)],
) => ({ id, label: id, supplyFields });

describe("product template manifest contract", () => {
  it("parses one implicit default and resolves fields only by explicit ID", () => {
    const catalog = parseProductTemplateCatalog({
      productTemplates: [
        {
          id: "camera.body",
          label: " Camera body ",
          description: " Public camera offers ",
          category: " Photography ",
          supplyFields: [{ key: "sensor_size", label: " Sensor size " }],
        },
      ],
    });

    expect(catalog).toEqual({
      productTemplates: [
        {
          id: "camera.body",
          label: "Camera body",
          description: "Public camera offers",
          category: "Photography",
          supplyFields: [{ key: "sensor_size", label: "Sensor size" }],
        },
      ],
    });
    expect(defaultProductTemplate(catalog!)).toEqual(
      expect.objectContaining({ id: "camera.body" }),
    );
    expect(supplyFieldsForProductTemplate(catalog!, "camera.body")).toEqual([
      { key: "sensor_size", label: "Sensor size" },
    ]);
    expect(supplyFieldsForProductTemplate(catalog!, "unknown")).toBeNull();
  });

  it("accepts descriptions at the schema boundary and rejects one character over", () => {
    const boundaryDescription = "d".repeat(
      MAX_PRODUCT_TEMPLATE_DESCRIPTION_LENGTH,
    );
    expect(
      parseProductTemplates([
        { ...template("book.v2"), description: boundaryDescription },
      ]),
    ).toEqual([{ ...template("book.v2"), description: boundaryDescription }]);
    expect(
      parseProductTemplates([
        { ...template("book.v2"), description: `${boundaryDescription}d` },
      ]),
    ).toBeNull();
  });

  it("requires a valid explicit default when multiple templates exist", () => {
    const productTemplates = [template("camera"), template("lens")];
    expect(parseProductTemplateCatalog({ productTemplates })).toBeNull();
    expect(
      parseProductTemplateCatalog({
        productTemplates,
        defaultProductTemplateId: "missing",
      }),
    ).toBeNull();
    expect(
      parseProductTemplateCatalog({
        productTemplates,
        defaultProductTemplateId: "lens",
      }),
    ).toEqual({ productTemplates, defaultProductTemplateId: "lens" });
  });

  it.each([
    "Camera",
    "1camera",
    "camera/body",
    `a${"b".repeat(64)}`,
  ])("rejects invalid template ID %s", (id) => {
    expect(parseProductTemplates([template(id)])).toBeNull();
  });

  it("rejects duplicate IDs and all catalog limits", () => {
    expect(
      parseProductTemplates([template("same"), template("same")]),
    ).toBeNull();
    expect(
      parseProductTemplates(
        Array.from({ length: 17 }, (_, index) => template(`t${index}`)),
      ),
    ).toBeNull();
    expect(
      parseProductTemplates([
        template(
          "oversized",
          Array.from({ length: 65 }, (_, index) => field(`field_${index}`)),
        ),
      ]),
    ).toBeNull();
    expect(
      parseProductTemplates(
        Array.from({ length: 5 }, (_, templateIndex) =>
          template(
            `t${templateIndex}`,
            Array.from({ length: 64 }, (_, fieldIndex) =>
              field(`shared_${fieldIndex}`),
            ),
          ),
        ),
      ),
    ).toBeNull();
    expect(
      parseProductTemplates([
        template(
          "first",
          Array.from({ length: 64 }, (_, index) => field(`first_${index}`)),
        ),
        template(
          "second",
          Array.from({ length: 64 }, (_, index) => field(`second_${index}`)),
        ),
        template("third", [field("one_more")]),
      ]),
    ).toBeNull();
  });

  it("requires duplicate shared keys to have the same normalized definition", () => {
    expect(
      parseProductTemplates([
        template("first", [
          { key: "weight", label: " Weight ", type: "number" },
        ]),
        template("second", [
          {
            key: "weight",
            label: "Weight",
            type: "number",
            required: false,
          },
        ]),
      ]),
    ).not.toBeNull();
    expect(
      parseProductTemplates([
        template("first", [
          { key: "weight", label: "Weight", type: "number", unit: "kg" },
        ]),
        template("second", [
          { key: "weight", label: "Weight", type: "number", unit: "lb" },
        ]),
      ]),
    ).toBeNull();
  });

  it("keeps legacy fields separate and rejects ambiguous dual declarations", () => {
    expect(
      parseProductTemplateCatalog({
        ui: { supplyFields: [{ key: "brand", label: "Brand" }] },
      }),
    ).toEqual({ productTemplates: [] });
    expect(
      parseProductTemplateCatalog({
        ui: { supplyFields: [] },
        productTemplates: [template("camera")],
      }),
    ).toBeNull();
    expect(
      parseProductTemplateCatalog({ defaultProductTemplateId: "camera" }),
    ).toBeNull();
  });

  it("rejects invalid supply fields and unsafe public keys", () => {
    expect(
      parseProductTemplates([
        template("bad", [{ key: "contact_email", label: "Email" }]),
      ]),
    ).toBeNull();
    expect(
      parseProductTemplates([
        template("bad", [
          { key: "size", label: "Size", type: "select", options: [] },
        ]),
      ]),
    ).toBeNull();
    expect(
      parseProductTemplates([
        template("bad", [{ key: "weight", label: "Weight", min: 0 }]),
      ]),
    ).toBeNull();
  });

  it.each([
    "id_card",
    "id_card_last4",
    "identity-card",
    "customer.identityCard",
    "identity_number",
    "national_id",
    "passport_number",
    "passport_expiry",
    "driverLicense",
    "owner_name",
    "customer-name",
    "buyer.full_name",
    "real_name",
    "legal-person-name",
    "legal_full_person_name",
    "full_name",
    "person_full_name",
    "account_holder_name",
    "account_holder",
    "date_of_birth",
    "residential_address",
    "customer_street_address",
    "bank_account_number",
    "customer.bankAccountHolderName",
    "identity_document_url",
    "personal-document-file",
    "ownership_document_image",
  ])("rejects private identity or personal-document field %s", (key) => {
    expect(
      parseProductTemplates([template("private", [field(key)])]),
    ).toBeNull();
  });

  it.each([
    "id",
    "name",
    "document",
    "model_id",
    "brand_name",
    "model_name",
    "certification_document_url",
    "public_documentation_url",
    "product_document_url",
    "passport_cover_material",
    "store_street_address",
  ])("keeps safe public product field %s", (key) => {
    expect(
      parseProductTemplates([template("public", [field(key)])]),
    ).not.toBeNull();
  });
});

describe("template field helpers", () => {
  it("normalizes implicit type and required defaults for equality", () => {
    expect(
      supplyFieldDefinitionsEqual(
        { key: "brand", label: " Brand " },
        { key: "brand", label: "Brand", type: "text", required: false },
      ),
    ).toBe(true);
  });

  it("reports retained, removed, changed, added, and newly required fields", () => {
    expect(
      productTemplateSwitchImpact(
        [
          { key: "brand", label: "Brand" },
          { key: "weight", label: "Weight", type: "number" },
          { key: "legacy", label: "Legacy" },
        ],
        [
          { key: "brand", label: "Brand", type: "text" },
          { key: "weight", label: "Mass", type: "number" },
          { key: "serial", label: "Serial", required: true },
        ],
      ),
    ).toEqual({
      keptKeys: ["brand"],
      addedKeys: ["serial"],
      removedKeys: ["legacy"],
      changedKeys: ["weight"],
      newlyRequiredKeys: ["serial"],
    });
  });
});
