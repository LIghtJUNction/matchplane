import { describe, expect, it } from "vitest";

import { conversionIdempotencyKey } from "./useStoreHandoff";

const session = {
  partyId: "00000000-0000-7000-8000-000000000001",
};
const intentId = "00000000-0000-7000-8000-000000000002";
const offerId = "00000000-0000-7000-8000-000000000003";

describe("conversion idempotency scope", () => {
  it("reuses one explicit confirmation attempt across retries", () => {
    const attemptId = "00000000-0000-7000-8000-000000000004";

    expect(
      conversionIdempotencyKey(
        session,
        "web-contact-request",
        attemptId,
        intentId,
        offerId,
      ),
    ).toBe(
      conversionIdempotencyKey(
        session,
        "web-contact-request",
        attemptId,
        intentId,
        offerId,
      ),
    );
  });

  it("creates a new action key for a later explicit confirmation", () => {
    const first = conversionIdempotencyKey(
      session,
      "web-contact-request",
      "00000000-0000-7000-8000-000000000004",
      intentId,
      offerId,
    );
    const next = conversionIdempotencyKey(
      session,
      "web-contact-request",
      "00000000-0000-7000-8000-000000000005",
      intentId,
      offerId,
    );

    expect(next).not.toBe(first);
  });

  it("rejects untrusted non-canonical IDs instead of hashing them into collisions", () => {
    expect(() =>
      conversionIdempotencyKey(
        session,
        "web-contact-request",
        "00000000-0000-7000-8000-000000000004",
        intentId,
        "seller-controlled-offer",
      ),
    ).toThrow("conversion idempotency scope is invalid");
  });
});
