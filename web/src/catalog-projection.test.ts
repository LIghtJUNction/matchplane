import { describe, expect, it } from "vitest";

import catalogProjectionSchema from "../../docs/catalog-protocol-v2.json";
import {
  buildCatalogProjectionArguments,
  parseCatalogProjectionAck,
} from "./catalog-projection";

const requestId = "44444444-4444-4444-8444-444444444444";
const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-4333-8333-333333333333";

function projection(
  attributes: Record<string, unknown> = { color: "ivory", year: 2026 },
  productTemplateId: string | null = null,
) {
  return buildCatalogProjectionArguments({
    requestId,
    tenantId,
    domainId,
    platformPath: "/auto",
    offer: {
      offerId,
      externalKey: "stock-1",
      displayName: "Canonical offer",
      productTemplateId,
      attributes,
      terms: { currency: "CNY", amount_minor: "1234" },
      status: "active",
      canonicalVersion: 7,
    },
  });
}

function ack(input = projection()): Record<string, unknown> {
  return {
    result: {
      structuredContent: {
        protocol: input.protocol,
        request_id: input.request_id,
        scope: input.scope,
        offer_id: input.offer.offer_id,
        canonical_version: input.canonical_version,
        applied_version: input.canonical_version,
        projection_digest: input.projection_digest,
        status: input.offer.status,
        indexed: true,
        applied: true,
      },
    },
  };
}

describe("catalog projection v2", () => {
  it("always sends the nullable snake_case product template binding", () => {
    expect(projection(undefined, "camera").offer.product_template_id).toBe(
      "camera",
    );
    expect(projection().offer).toHaveProperty("product_template_id", null);
  });

  it("changes the digest when the product template binding changes", () => {
    expect(projection(undefined, "camera").projection_digest).not.toBe(
      projection(undefined, "book.v2").projection_digest,
    );
  });

  it("keeps the client schema nullable but requires the field", () => {
    const offerSchema = catalogProjectionSchema.properties.offer;
    expect(offerSchema.required).toContain("product_template_id");
    expect(offerSchema.properties.product_template_id).toEqual({
      description:
        "Manifest-declared product template binding; legacy offers without a template catalog send null.",
      type: ["string", "null"],
      pattern: "^[a-z][a-z0-9._-]{0,63}$",
    });
  });

  it("produces the same digest regardless of JSON object key order", () => {
    expect(projection({ year: 2026, color: "ivory" }).projection_digest).toBe(
      projection({ color: "ivory", year: 2026 }).projection_digest,
    );
  });

  it("accepts an exact monotonic child ACK", () => {
    expect(parseCatalogProjectionAck(ack(), projection())).toEqual({
      ok: true,
      superseded: false,
      appliedVersion: 7,
      applied: true,
    });
  });

  it("rejects a same-version ACK with another projection digest", () => {
    const response = ack();
    const structured = (
      response.result as { structuredContent: Record<string, unknown> }
    ).structuredContent;
    structured.projection_digest = "0".repeat(64);
    expect(parseCatalogProjectionAck(response, projection())).toEqual({
      ok: false,
      error: "child catalog ACK projection digest mismatch",
    });
  });

  it("treats an already-applied newer child version as superseding the job", () => {
    const response = ack();
    const structured = (
      response.result as { structuredContent: Record<string, unknown> }
    ).structuredContent;
    structured.applied_version = 8;
    structured.status = "withdrawn";
    structured.indexed = false;
    structured.applied = false;
    expect(parseCatalogProjectionAck(response, projection())).toEqual({
      ok: true,
      superseded: true,
      appliedVersion: 8,
      applied: false,
    });
  });
});
