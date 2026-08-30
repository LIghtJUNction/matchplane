import { describe, expect, it, vi } from "vitest";

import {
  type GatewayLexicalRankedCandidate,
  LEXICAL_RANK_ADVISORY,
  type PreparedLexicalRankCandidate,
} from "./storefront-ranking-gateway";
import {
  boundedMatchReasons,
  publicPrimitiveAttributeDescription,
  rankPublicStorefrontCandidates,
} from "./storefront-ranking";

interface Row {
  id: string;
}

function candidate(
  id: string,
  attributes: Record<string, unknown> = { description: "公开说明" },
) {
  return {
    row: { id } satisfies Row,
    displayName: `商品 ${id}`,
    attributes,
    terms: {
      pricing_mode: "fixed",
      amount_minor: "10000",
      currency: "CNY",
      currency_scale: 2,
    },
  };
}

function rustResult(
  candidateIndex: number,
  score: number,
  overlapCount: number,
  overlapLabels: string[] = [],
): GatewayLexicalRankedCandidate {
  return {
    candidateIndex,
    score,
    overlapCount,
    overlapLabels,
    advisory: LEXICAL_RANK_ADVISORY,
  };
}

describe("public storefront Rust ranking integration", () => {
  it("keeps empty browse unscored without loading or calling the Rust ranker", async () => {
    const rustRanker = vi.fn();

    const ranked = await rankPublicStorefrontCandidates(
      [candidate("a"), candidate("b")],
      "   ",
      undefined,
      rustRanker,
    );

    expect(rustRanker).not.toHaveBeenCalled();
    expect(ranked.map(({ row, score }) => ({ id: row.id, score }))).toEqual([
      { id: "a", score: undefined },
      { id: "b", score: undefined },
    ]);
  });

  it("sends Web-owned eligibility, boost, and reasons and keeps a structured-only Rust row", async () => {
    const rustRanker = vi.fn(
      async (
        _narrative: string,
        candidates: PreparedLexicalRankCandidate[],
      ) => {
        expect(candidates).toEqual([
          expect.objectContaining({
            eligible: true,
            intentBoost: 0.32,
            intentReasons: ["币种符合 CNY", "价格符合预算"],
          }),
        ]);
        return [rustResult(0, 0.32, 0)];
      },
    );

    const ranked = await rankPublicStorefrontCandidates(
      [candidate("structured")],
      "",
      { budget: { maximum: 200, currency: "CNY" }, requirements: [] },
      rustRanker,
    );

    expect(ranked).toEqual([
      expect.objectContaining({
        score: 0.32,
        overlapCount: 0,
        overlapLabels: [],
        intentReasons: ["币种符合 CNY", "价格符合预算"],
      }),
    ]);
  });

  it("uses the frozen global merge order rather than per-batch return order", async () => {
    const rustRanker = vi.fn(async () => [
      rustResult(2, 0.9, 1, ["c"]),
      rustResult(0, 0.4, 2, ["a", "b"]),
      rustResult(1, 0.8, 1, ["a"]),
      rustResult(3, 0.8, 1, ["a"]),
    ]);

    const ranked = await rankPublicStorefrontCandidates(
      [candidate("0"), candidate("1"), candidate("2"), candidate("3")],
      "camera",
      undefined,
      rustRanker,
    );

    expect(ranked.map(({ row }) => row.id)).toEqual(["0", "2", "1", "3"]);
    expect(ranked.map(({ score }) => score)).toEqual([0.4, 0.9, 0.8, 0.8]);
  });

  it("builds a stable scalar-bounded description from public primitives only", () => {
    const description = publicPrimitiveAttributeDescription({
      zeta: 3,
      nested: { secret: "not public" },
      provider_hints: "never send",
      manifest: "never send raw manifest",
      contact_phone: "13800000000",
      authorization: "Bearer must-not-cross",
      cookie: "session=must-not-cross",
      alpha: "first",
      boolean_value: true,
      long: "😀".repeat(8_100),
    });

    expect(description.startsWith("first\ntrue\n")).toBe(true);
    expect([...description]).toHaveLength(8_000);
    expect(description).not.toContain("never send");
    expect(description).not.toContain("13800000000");
    expect(description).not.toContain("must-not-cross");
    expect(description).not.toContain("not public");
  });

  it("bounds reasons by Unicode scalar count without splitting astral text", () => {
    const reasons = boundedMatchReasons([
      "😀".repeat(600),
      "same",
      "same",
      ...Array.from({ length: 12 }, (_, index) => `reason-${index}`),
    ]);

    expect(reasons).toHaveLength(8);
    expect([...reasons[0]!]).toHaveLength(500);
    expect(reasons[0]!.endsWith("😀")).toBe(true);
    expect(reasons.filter((reason) => reason === "same")).toHaveLength(1);
  });
});
