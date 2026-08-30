import { describe, expect, it } from "vitest";

import { normalizePlatformPath, parseAgentHandoff } from "./platform-agent-handoff";

const valid = {
  protocol: "matchplane.agent/v1",
  request_id: "123e4567-e89b-12d3-a456-426614174000",
  stage: "platform",
  scope: { platform_path: "/" },
  intent: { narrative: "找一个合适的供给", requirements: { budget: { max: 100000 } } },
  agent: { id: "buyer.example", version: "1.0.0", capabilities: ["search", "rank"] },
  budget: { max_steps: 8, max_input_characters: 24000, max_output_tokens: 512, cost_bearer: "caller" },
};

describe("caller-funded Agent handoff", () => {
  it("normalizes paths and preserves the bounded caller budget", () => {
    expect(normalizePlatformPath("//store-a//")).toBe("/store-a");
    const result = parseAgentHandoff(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.platformPath).toBe("/");
      expect(result.value.budget.costBearer).toBe("caller");
    }
  });

  it("keeps stage taxonomy owned by the mounted domain", () => {
    const result = parseAgentHandoff({ ...valid, stage: "profile.compatibility" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stage).toBe("profile.compatibility");
  });

  it("rejects a platform-funded external handoff", () => {
    const result = parseAgentHandoff({
      ...valid,
      budget: { ...valid.budget, cost_bearer: "platform" },
    });
    expect(result).toEqual({ ok: false, error: "external handoff must use bounded caller-funded budget" });
  });

  it("rejects unknown fields and oversized requirements", () => {
    expect(parseAgentHandoff({ ...valid, callback: "https://example.com" }).ok).toBe(false);
    expect(parseAgentHandoff({
      ...valid,
      intent: { narrative: "x", requirements: { blob: "x".repeat(33_000) } },
    }).ok).toBe(false);
  });
});
