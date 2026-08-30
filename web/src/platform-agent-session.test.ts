import { describe, expect, it } from "vitest";

import {
  keyCanActAsNeutralSide,
  keyCanActAs,
  parseAgentSessionRequest,
  stableAgentPrincipalId,
} from "./platform-agent-session";

const valid = {
  tenantId: "123e4567-e89b-12d3-a456-426614174000",
  domainId: "223e4567-e89b-12d3-a456-426614174000",
  platformPath: "/store-a",
  role: "buyer",
};

describe("external Agent marketplace capability exchange", () => {
  it("accepts a scoped role request without accepting a caller participant id", () => {
    const result = parseAgentSessionRequest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.role).toBe("buyer");
      expect(result.value.side).toBe("demand");
      expect(result.value.displayName).toBe("MatchPlane external Agent");
    }
  });

  it("accepts the domain-neutral side without requiring a vertical role label", () => {
    const result = parseAgentSessionRequest({
      ...valid,
      role: undefined,
      side: "supply",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.side).toBe("supply");
      expect(result.value.role).toBe("seller");
    }
  });

  it("accepts root scope and rejects unsupported fields", () => {
    expect(parseAgentSessionRequest({ ...valid, platformPath: "/" }).ok).toBe(
      true,
    );
    expect(
      parseAgentSessionRequest({ ...valid, callbackUrl: "https://example.com" })
        .ok,
    ).toBe(false);
  });

  it("rejects contradictory neutral and compatibility labels", () => {
    expect(
      parseAgentSessionRequest({ ...valid, side: "supply", role: "buyer" }).ok,
    ).toBe(false);
  });

  it("keeps machine principals stable per API key and tenant", () => {
    const first = stableAgentPrincipalId("key-1", valid.tenantId);
    expect(first).toBe(stableAgentPrincipalId("key-1", valid.tenantId));
    expect(first).not.toBe(stableAgentPrincipalId("key-2", valid.tenantId));
    expect(first).not.toBe(
      stableAgentPrincipalId(
        "key-1",
        "323e4567-e89b-12d3-a456-426614174000", // gitleaks:allow -- deterministic machine-principal fixture
      ),
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("does not widen a role-scoped API key", () => {
    expect(keyCanActAs("buyer", "buyer")).toBe(true);
    expect(keyCanActAs("buyer", "seller")).toBe(false);
    expect(keyCanActAs("both", "seller")).toBe(true);
  });

  it("keeps neutral side-scoped API keys independent from buyer/seller labels", () => {
    expect(keyCanActAsNeutralSide("demand", "demand")).toBe(true);
    expect(keyCanActAsNeutralSide("demand", "supply")).toBe(false);
    expect(keyCanActAsNeutralSide("both", "supply")).toBe(true);
  });
});
