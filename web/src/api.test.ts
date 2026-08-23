import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPartySessionCache,
  readPartySession,
  savePartySession,
} from "./api";

describe("marketplace capability cache", () => {
  beforeEach(() => clearPartySessionCache());

  it("rejects an expired capability so the caller can exchange a fresh one", () => {
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "expired",
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      "used-car",
    );

    expect(readPartySession("buyer", "used-car")).toBeNull();
  });

  it("accepts only a capability whose deadline is still in the future", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "active",
        accessTokenExpiresAt: expiresAt,
      },
      "used-car",
    );

    expect(readPartySession("buyer", "used-car")?.accessToken).toBe("active");
  });

  it("shares a dual-role store capability between buyer and seller surfaces", () => {
    const session = {
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      partyId: "223e4567-e89b-12d3-a456-426614174000",
      role: "both" as const,
      accessToken: "shared",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      platformPath: "/used-car",
    };
    savePartySession(session, "used-car", "seller", "/used-car");

    expect(
      readPartySession("buyer", "used-car", "/used-car")?.accessToken,
    ).toBe("shared");
    expect(
      readPartySession("seller", "used-car", "/used-car")?.accessToken,
    ).toBe("shared");
  });

  it("does not let an expired admin cache hide a valid dual-role capability", () => {
    const base = {
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      partyId: "223e4567-e89b-12d3-a456-426614174000",
      role: "both" as const,
    };
    savePartySession(
      {
        ...base,
        accessToken: "expired",
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      "used-car",
      "admin",
    );
    savePartySession(
      {
        ...base,
        accessToken: "active",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "used-car",
      "both",
    );

    expect(readPartySession("admin", "used-car")?.accessToken).toBe("active");
  });

  it("does not reuse a capability after the Better Auth user changes", () => {
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        authUserId: "333e4567-e89b-12d3-a456-426614174000", // gitleaks:allow -- deterministic UUID fixture
        role: "buyer",
        accessToken: "alice",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "used-car",
      "buyer",
    );

    expect(
      readPartySession(
        "buyer",
        "used-car",
        undefined,
        "444e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBeNull();
  });

  it("never writes the short-lived bearer to browser storage", () => {
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "memory-only",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "used-car",
    );

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
