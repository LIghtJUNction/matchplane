import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLexicalRankBatches,
  LEXICAL_RANK_ADVISORY,
  LEXICAL_RANK_TOTAL_DEADLINE_MS,
  MAX_LEXICAL_RANK_CONCURRENCY,
  MAX_LEXICAL_RANK_REQUEST_BYTES,
  MAX_LEXICAL_RANK_RESPONSE_BYTES,
  type PreparedLexicalRankCandidate,
  PublicStorefrontRankingError,
  rankWithRustLexicalGateway,
} from "./storefront-ranking-gateway";

const originalToken = process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN;
const originalTokenFile = process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE;

function candidate(
  overrides: Partial<PreparedLexicalRankCandidate> = {},
): PreparedLexicalRankCandidate {
  return {
    displayName: "公开商品",
    description: "公开说明\nAurora",
    eligible: true,
    intentBoost: 0.08,
    intentReasons: ["币种符合 CNY"],
    ...overrides,
  };
}

function validRankedRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    candidate_index: 0,
    score: 0.4,
    overlap_count: 1,
    overlap_labels: ["公开"],
    advisory: LEXICAL_RANK_ADVISORY,
    ...overrides,
  };
}

function rankedResponse(
  requestBody: string,
  row?: (index: number) => Record<string, unknown>,
): Response {
  const request = JSON.parse(requestBody) as {
    candidates: PreparedLexicalRankCandidate[];
  };
  return Response.json({
    schema_version: 1,
    ranked: request.candidates.map((_value, index) =>
      row ? row(index) : validRankedRow({ candidate_index: index }),
    ),
  });
}

function rankingError(kind: string) {
  return expect.objectContaining({
    name: PublicStorefrontRankingError.name,
    code: "public_storefront_ranking_failed",
    kind,
  });
}

afterEach(() => {
  if (originalToken === undefined)
    delete process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN;
  else process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN = originalToken;
  if (originalTokenFile === undefined)
    delete process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE;
  else process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE = originalTokenFile;
  vi.restoreAllMocks();
});

describe("internal Rust lexical rank gateway client", () => {
  it("posts only the frozen public candidate contract with a server bearer", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        rankedResponse(String(init?.body)),
    );
    const publicCandidate = {
      ...candidate(),
      provider_hints: ["must not cross the boundary"],
      contact_phone: "13800000000",
      raw_manifest: { secret: true },
      terms: { amount_minor: "100" },
    } as PreparedLexicalRankCandidate;

    const ranked = await rankWithRustLexicalGateway(
      "想找公开商品",
      [publicCandidate],
      {
        endpoint: "http://gateway.internal",
        fetchImplementation,
        loadBearer: async () => "server-only-token",
      },
    );

    expect(ranked).toEqual([
      expect.objectContaining({ candidateIndex: 0, score: 0.4 }),
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "http://gateway.internal/v1/internal/matching/lexical-rank",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer server-only-token",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      narrative: "想找公开商品",
      candidates: [
        {
          display_name: "公开商品",
          description: "公开说明\nAurora",
          eligible: true,
          intent_boost: 0.08,
          intent_reasons: ["币种符合 CNY"],
        },
      ],
    });
    expect(String(init?.body)).not.toContain("provider_hints");
    expect(String(init?.body)).not.toContain("13800000000");
    expect(String(init?.body)).not.toContain("raw_manifest");
    expect(String(init?.body)).not.toContain("amount_minor");
  });

  it("covers all 2,000 candidates without truncating any global index", async () => {
    const requestSizes: number[] = [];
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body);
        const request = JSON.parse(body) as { candidates: unknown[] };
        requestSizes.push(request.candidates.length);
        return rankedResponse(body);
      },
    );

    const ranked = await rankWithRustLexicalGateway(
      "camera",
      Array.from({ length: 2_000 }, (_, index) =>
        candidate({ displayName: `商品 ${index}` }),
      ),
      { fetchImplementation, loadBearer: async () => "token" },
    );

    expect(requestSizes).toHaveLength(32);
    expect(requestSizes.reduce((total, size) => total + size, 0)).toBe(2_000);
    expect(requestSizes.every((size) => size <= 64)).toBe(true);
    expect(
      ranked.map((row) => row.candidateIndex).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 2_000 }, (_, index) => index));
  });

  it("starts a new batch before the encoded UTF-8 byte budget is exceeded", () => {
    const large = candidate({
      displayName: "名".repeat(512),
      description: "述".repeat(8_000),
      intentReasons: Array.from({ length: 8 }, () => "理".repeat(500)),
    });
    const batches = buildLexicalRankBatches(
      "叙".repeat(8_000),
      Array.from({ length: 30 }, () => large),
    );

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.candidates.length < 30)).toBe(true);
    expect(
      batches.every(
        (batch) =>
          new TextEncoder().encode(batch.body).byteLength <=
          MAX_LEXICAL_RANK_REQUEST_BYTES,
      ),
    ).toBe(true);
    expect(batches.flatMap((batch) => batch.candidateIndexes)).toEqual(
      Array.from({ length: 30 }, (_, index) => index),
    );
  });

  it("returns a typed refusal when one candidate cannot fit the byte budget", () => {
    expect(() => buildLexicalRankBatches("query", [candidate()], 32)).toThrow(
      rankingError("request_too_large"),
    );
  });

  it("never runs more than four batch requests concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
        return rankedResponse(String(init?.body));
      },
    );
    const pending = rankWithRustLexicalGateway(
      "camera",
      Array.from({ length: 640 }, () => candidate()),
      { fetchImplementation, loadBearer: async () => "token" },
    );

    await vi.waitFor(() =>
      expect(fetchImplementation).toHaveBeenCalledTimes(
        MAX_LEXICAL_RANK_CONCURRENCY,
      ),
    );
    expect(maximumActive).toBe(MAX_LEXICAL_RANK_CONCURRENCY);
    release();
    await expect(pending).resolves.toHaveLength(640);
    expect(maximumActive).toBe(MAX_LEXICAL_RANK_CONCURRENCY);
  });

  it("fails closed before fetch when the server token is missing", async () => {
    delete process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN;
    delete process.env.MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE;
    const fetchImplementation = vi.fn();

    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation,
      }),
    ).rejects.toEqual(rankingError("configuration"));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("uses one bounded deadline for all requests", async () => {
    const fetchImplementation = vi.fn(
      () => new Promise<Response>(() => undefined),
    );

    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        deadlineMs: 10,
        fetchImplementation,
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(rankingError("timeout"));
    expect(LEXICAL_RANK_TOTAL_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });

  it("fails closed on network errors and non-2xx responses", async () => {
    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation: async () => {
          throw new Error("connection detail must not escape");
        },
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(rankingError("network"));

    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation: async () =>
          new Response("private", { status: 503 }),
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ kind: "upstream_http", status: 503 }),
    );
  });

  it("rejects an oversized response before parsing it", async () => {
    const oversized = JSON.stringify({
      schema_version: 1,
      ranked: [],
      padding: "x".repeat(MAX_LEXICAL_RANK_RESPONSE_BYTES),
    });

    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation: async () => Response.json(JSON.parse(oversized)),
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(rankingError("response_too_large"));
  });

  it("requires JSON content type on successful responses", async () => {
    const rank = (contentType: string) =>
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation: async () =>
          new Response(JSON.stringify({ schema_version: 1, ranked: [] }), {
            headers: { "content-type": contentType },
          }),
        loadBearer: async () => "token",
      });

    await expect(rank("application/json; charset=utf-8")).resolves.toEqual([]);
    await expect(rank("text/plain")).rejects.toEqual(
      rankingError("malformed_response"),
    );
  });

  it.each([
    ["wrong schema", { schema_version: 2, ranked: [] }],
    ["missing rows", { schema_version: 1 }],
    ["extra top-level key", { schema_version: 1, ranked: [], extra: true }],
    [
      "unknown index",
      { schema_version: 1, ranked: [validRankedRow({ candidate_index: 1 })] },
    ],
    [
      "non-finite score",
      { schema_version: 1, ranked: [validRankedRow({ score: "NaN" })] },
    ],
    [
      "negative overlap",
      { schema_version: 1, ranked: [validRankedRow({ overlap_count: -1 })] },
    ],
    [
      "overlap count above kernel bound",
      { schema_version: 1, ranked: [validRankedRow({ overlap_count: 513 })] },
    ],
    [
      "advisory object",
      { schema_version: 1, ranked: [validRankedRow({ advisory: {} })] },
    ],
    [
      "wrong advisory string",
      { schema_version: 1, ranked: [validRankedRow({ advisory: "other" })] },
    ],
    [
      "extra row key",
      { schema_version: 1, ranked: [validRankedRow({ extra: true })] },
    ],
    [
      "nine overlap labels",
      {
        schema_version: 1,
        ranked: [
          validRankedRow({
            overlap_count: 9,
            overlap_labels: Array.from({ length: 9 }, (_, index) => `${index}`),
          }),
        ],
      },
    ],
    [
      "501-scalar label",
      {
        schema_version: 1,
        ranked: [validRankedRow({ overlap_labels: ["😀".repeat(501)] })],
      },
    ],
    [
      "overlap count smaller than labels",
      {
        schema_version: 1,
        ranked: [
          validRankedRow({ overlap_count: 1, overlap_labels: ["a", "b"] }),
        ],
      },
    ],
  ])("rejects malformed response: %s", async (_name, payload) => {
    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation: async () => Response.json(payload),
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(rankingError("malformed_response"));
  });

  it("rejects duplicate rows and rows for Web-ineligible candidates", async () => {
    const duplicate = validRankedRow({ overlap_count: 0, overlap_labels: [] });
    await expect(
      rankWithRustLexicalGateway("camera", [candidate()], {
        fetchImplementation: async () =>
          Response.json({ schema_version: 1, ranked: [duplicate, duplicate] }),
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(rankingError("malformed_response"));

    await expect(
      rankWithRustLexicalGateway("camera", [candidate({ eligible: false })], {
        fetchImplementation: async () =>
          Response.json({ schema_version: 1, ranked: [duplicate] }),
        loadBearer: async () => "token",
      }),
    ).rejects.toEqual(rankingError("malformed_response"));
  });
});
