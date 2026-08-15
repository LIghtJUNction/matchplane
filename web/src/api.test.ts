import { beforeEach, describe, expect, it } from "vitest";

import { readPartySession } from "./api";

describe("marketplace capability cache", () => {
  beforeEach(() => window.localStorage.clear());

  it("rejects an expired capability so the caller can exchange a fresh one", () => {
    window.localStorage.setItem(
      "matchplane.party.used-car.buyer",
      JSON.stringify({
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "expired",
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );

    expect(readPartySession("buyer", "used-car")).toBeNull();
  });

  it("accepts only a capability whose deadline is still in the future", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    window.localStorage.setItem(
      "matchplane.party.used-car.buyer",
      JSON.stringify({
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "active",
        accessTokenExpiresAt: expiresAt,
      }),
    );

    expect(readPartySession("buyer", "used-car")?.accessToken).toBe("active");
  });

  it("does not let an expired admin cache hide a valid dual-role capability", () => {
    const base = {
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      partyId: "223e4567-e89b-12d3-a456-426614174000",
      role: "both",
    };
    window.localStorage.setItem(
      "matchplane.party.used-car.admin",
      JSON.stringify({ ...base, accessToken: "expired", accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    window.localStorage.setItem(
      "matchplane.party.used-car.both",
      JSON.stringify({ ...base, accessToken: "active", accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );

    expect(readPartySession("admin", "used-car")?.accessToken).toBe("active");
    expect(window.localStorage.getItem("matchplane.party.used-car.admin")).toBeNull();
  });
});
