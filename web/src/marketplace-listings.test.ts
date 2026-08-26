import { describe, expect, it } from "vitest";

import type { RecommendedBackendListing } from "./api";
import { mapRecommendations } from "./marketplace-listings";
import {
  MAX_PUBLIC_MATCH_REASON_CHARACTERS,
  MAX_PUBLIC_MATCH_REASONS,
} from "./storefront-ranking-shared";
import type { SubplatformConfig } from "./subplatform";

const subplatform: SubplatformConfig = {
  slug: "store-one",
  path: "/store-one",
  brandName: "Store One",
  label: "Store One",
  description: "A test store",
};

function recommendation(
  overrides: Partial<RecommendedBackendListing> = {},
): RecommendedBackendListing {
  return {
    offer_id: "offer-1",
    tenant_id: "tenant-1",
    domain_id: "domain-1",
    display_name: "Canonical offer",
    attributes: {},
    terms: { pricing_mode: "none" },
    platform_path: "/store-one",
    subplatform: "store-one",
    ...overrides,
  };
}

describe("marketplace recommendation mapping", () => {
  it("keeps canonical reasons and advisory provider hints in separate fields", () => {
    const [listing] = mapRecommendations(
      [
        recommendation({
          match_score: 0.834,
          match_reasons: ["Verified canonical reason"],
          provider_hints: ["Advisory provider hint"],
        }),
      ],
      subplatform,
      "en",
    );

    expect(listing).toMatchObject({
      matchScore: 83,
      reasons: ["Verified canonical reason"],
      providerHints: ["Advisory provider hint"],
    });
    expect(listing.reasons?.includes("Advisory provider hint")).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("keeps an %s score absent", (_label, score) => {
    const item = recommendation({ match_reasons: ["Canonical reason"] });
    if (score !== undefined) item.match_score = score;

    const [listing] = mapRecommendations([item], subplatform, "en");

    expect(Object.hasOwn(listing, "matchScore")).toBe(false);
  });

  it("maps a finite server score even without an intent identifier", () => {
    const [listing] = mapRecommendations(
      [recommendation({ match_score: 0.416 })],
      subplatform,
      "en",
    );

    expect(listing.matchScore).toBe(42);
  });

  it("bounds and deduplicates explanation fields at the listing boundary", () => {
    const longValues = Array.from(
      { length: MAX_PUBLIC_MATCH_REASONS + 3 },
      (_, index) =>
        `${index}-${"x".repeat(MAX_PUBLIC_MATCH_REASON_CHARACTERS)}`,
    );
    const [listing] = mapRecommendations(
      [
        recommendation({
          match_reasons: [longValues[0], longValues[0], ...longValues],
          provider_hints: [longValues[1], longValues[1], ...longValues],
        }),
      ],
      subplatform,
      "en",
    );

    for (const values of [listing.reasons ?? [], listing.providerHints ?? []]) {
      expect(values).toHaveLength(MAX_PUBLIC_MATCH_REASONS);
      expect(new Set(values).size).toBe(values.length);
      expect(
        values.every(
          (value) => value.length <= MAX_PUBLIC_MATCH_REASON_CHARACTERS,
        ),
      ).toBe(true);
    }
  });

  it("preserves empty recommendation behavior", () => {
    expect(mapRecommendations([], subplatform, "en")).toEqual([]);
  });
});
