import { describe, expect, it } from "vitest";

import type { MarketplaceOfferCandidate } from "./api";
import {
  MAX_PUBLIC_MATCH_REASON_CHARACTERS,
  MAX_PUBLIC_MATCH_REASONS,
} from "./storefront-ranking-shared";
import {
  buildCanonicalRecommendations,
  buildProviderSelectedRecommendations,
} from "./recommendation-provenance";
import type { RetrievalCandidate } from "./retrieval-protocol";

const canonicalCandidate: MarketplaceOfferCandidate = {
  offer_id: "offer-1",
  tenant_id: "tenant-1",
  domain_id: "domain-1",
  supply_party_id: "seller-1",
  external_key: "external-1",
  display_name: "Canonical offer",
  attributes: { material: "steel" },
  terms: { pricing_mode: "none" },
  status: "active",
  version: 1,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  score: 0.82,
  reasons: ["Verified material match"],
  risks: ["Verified availability risk"],
};

const context = {
  domainId: "domain-1",
  platformPath: "/store-one",
  subplatform: "store-one",
  intentId: "intent-1",
  fieldLabels: () => ({ material: "Material" }),
};

describe("recommendation provenance", () => {
  it("keeps provider explanations advisory and canonical score evidence authoritative", () => {
    const providerCandidate: RetrievalCandidate = {
      offerId: "offer-1",
      score: -1,
      reasons: ["Provider semantic similarity", "Provider semantic similarity"],
      risks: ["Provider-generated risk"],
    };

    expect(
      buildProviderSelectedRecommendations(
        [canonicalCandidate],
        [providerCandidate],
        context,
      ),
    ).toEqual([
      expect.objectContaining({
        match_score: 0.82,
        match_reasons: ["Verified material match"],
        match_risks: ["Verified availability risk"],
        provider_hints: ["Provider semantic similarity"],
      }),
    ]);
  });

  it("bounds and deduplicates canonical reasons and provider hints independently", () => {
    const longReasons = Array.from(
      { length: MAX_PUBLIC_MATCH_REASONS + 3 },
      (_, index) =>
        `${index}-${"x".repeat(MAX_PUBLIC_MATCH_REASON_CHARACTERS)}`,
    );
    const canonical = {
      ...canonicalCandidate,
      reasons: [longReasons[0], longReasons[0], ...longReasons],
    };
    const provider: RetrievalCandidate = {
      offerId: "offer-1",
      score: 1,
      reasons: [longReasons[1], longReasons[1], ...longReasons],
    };

    const [recommendation] = buildProviderSelectedRecommendations(
      [canonical],
      [provider],
      context,
    );

    for (const values of [
      recommendation.match_reasons,
      recommendation.provider_hints,
    ]) {
      expect(values).toHaveLength(MAX_PUBLIC_MATCH_REASONS);
      const boundedValues = values ?? [];
      expect(new Set(boundedValues).size).toBe(boundedValues.length);
      expect(
        boundedValues.every(
          (value) => value.length <= MAX_PUBLIC_MATCH_REASON_CHARACTERS,
        ),
      ).toBe(true);
    }
  });

  it("keeps canonical fallback and empty provider selections free of advisory fields", () => {
    expect(
      buildProviderSelectedRecommendations([canonicalCandidate], [], context),
    ).toEqual([]);

    const [recommendation] = buildCanonicalRecommendations(
      [canonicalCandidate],
      context,
    );
    expect(Object.hasOwn(recommendation, "provider_hints")).toBe(false);
    expect(recommendation.match_reasons).toEqual(["Verified material match"]);
  });
});
