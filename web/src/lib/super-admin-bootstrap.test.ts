import { describe, expect, it } from "vitest";

import {
  isReservedSuperAdminEmail,
  matchesReservedSuperAdminInvite,
  readSuperAdminBootstrapClaimToken,
  SUPER_ADMIN_BOOTSTRAP_COOKIE,
  superAdminBootstrapDigest,
} from "./super-admin-bootstrap";

const token = `mpsa_${"a".repeat(64)}`;
const digest = superAdminBootstrapDigest(token);
const invite = {
  registrationEmail: "owner@example.com",
  targetEmail: null,
  tokenHash: digest,
};

describe("super administrator bootstrap claim", () => {
  it("does not promote a matching email without the browser-bound token proof", () => {
    expect(
      matchesReservedSuperAdminInvite(invite, "owner@example.com", null),
    ).toBe(false);
  });

  it("holds a targeted email before the operator claims the token", () => {
    const targetedInvite = {
      ...invite,
      registrationEmail: null,
      targetEmail: "owner@example.com",
    };
    expect(isReservedSuperAdminEmail(targetedInvite, "owner@example.com")).toBe(
      true,
    );
    expect(
      matchesReservedSuperAdminInvite(
        targetedInvite,
        "owner@example.com",
        token,
      ),
    ).toBe(false);
  });

  it("matches the reserved email only with the original bearer token", () => {
    expect(
      matchesReservedSuperAdminInvite(invite, "OWNER@example.com", token),
    ).toBe(true);
    expect(
      matchesReservedSuperAdminInvite(invite, "owner@example.com", digest),
    ).toBe(false);
    expect(
      matchesReservedSuperAdminInvite(
        invite,
        "owner@example.com",
        `mpsa_${"0".repeat(64)}`,
      ),
    ).toBe(false);
  });

  it("rejects ambiguous duplicate claim cookies", () => {
    const headers = new Headers({
      cookie: `${SUPER_ADMIN_BOOTSTRAP_COOKIE}=${token}; ${SUPER_ADMIN_BOOTSTRAP_COOKIE}=${token}`,
    });

    expect(readSuperAdminBootstrapClaimToken(headers)).toBeNull();
  });
});
