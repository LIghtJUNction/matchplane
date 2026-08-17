import { describe, expect, it } from "vitest";

import {
  extractMcpRetrievalResult,
  parseRetrievalQuery,
  parseRetrievalResult,
} from "./retrieval-protocol";

const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const offerId = "55555555-5555-4555-8555-555555555555";

function query() {
  return {
    protocol: "matchplane.retrieval/v1",
    request_id: requestId,
    scope: { tenant_id: tenantId, domain_id: domainId, platform_path: "/used-car" },
    input: { narrative: "找适合城市通勤的供给", requirements: { energy: "electric" } },
    limit: 10,
  };
}

describe("retrieval protocol v1", () => {
  it("normalizes a scoped query without interpreting domain attributes", () => {
    const parsed = parseRetrievalQuery(query());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.platformPath).toBe("/used-car");
      expect(parsed.value.input.requirements).toEqual({ energy: "electric" });
    }
  });

  it("requires the recursive path and rejects unknown fields", () => {
    expect(parseRetrievalQuery({ ...query(), scope: { tenant_id: tenantId, domain_id: domainId } })).toMatchObject({ ok: false });
    expect(parseRetrievalQuery({ ...query(), unexpected: true })).toMatchObject({ ok: false });
  });

  it("extracts structured JSON from an MCP tool result and validates candidates", () => {
    const extracted = extractMcpRetrievalResult({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          protocol: "matchplane.retrieval/v1",
          request_id: requestId,
          provider: { id: "child.index", version: "2026.08" },
          candidates: [{
            asset_id: assetId,
            offer_id: offerId,
            display_name: "可联系的供给",
            attributes: { kind: "service" },
            terms: { pricing_mode: "negotiable" },
            score: 0.87,
            reasons: ["预算匹配"],
          }],
          degraded: false,
        }) }],
      },
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const parsed = parseRetrievalResult(extracted.value, requestId, 10);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.candidates[0]?.offerId).toBe(offerId);
  });

  it("rejects a provider response that changes request scope or exceeds the limit", () => {
    const base = {
      protocol: "matchplane.retrieval/v1",
      request_id: requestId,
      provider: { id: "child.index", version: "2026.08" },
      candidates: [],
      degraded: false,
    };
    expect(parseRetrievalResult({ ...base, request_id: tenantId }, requestId, 10)).toMatchObject({ ok: false });
    expect(parseRetrievalResult({ ...base, candidates: Array.from({ length: 11 }, () => ({ asset_id: assetId, score: 0, reasons: [] })) }, requestId, 10)).toMatchObject({ ok: false });
  });
});
