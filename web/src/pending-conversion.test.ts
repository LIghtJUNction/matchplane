import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_CONVERSION_KEY,
  PENDING_CONVERSION_TTL_MS,
  clearPendingConversion,
  ensurePendingConversion,
  readPendingConversion,
  savePendingConversion,
  updatePendingConversion,
} from "./pending-conversion";

describe("pending conversion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("persists the store, offer and action with a bounded expiry", () => {
    const pending = savePendingConversion(
      {
        storePath: "/store-a",
        offerId: "00000000-0000-7000-8000-000000000001",
        action: "contact_listing",
        conversionAttemptId: "attempt-0001",
      },
      1_000,
    );

    expect(pending).toMatchObject({
      storePath: "/store-a",
      offerId: "00000000-0000-7000-8000-000000000001",
      action: "contact_listing",
      conversionAttemptId: "attempt-0001",
      createdAt: 1_000,
      expiresAt: 1_000 + PENDING_CONVERSION_TTL_MS,
    });
    expect(readPendingConversion(2_000)).toEqual(pending);
  });

  it("expires and removes a stale conversion instead of restoring it", () => {
    savePendingConversion(
      {
        storePath: "/store-a",
        offerId: "offer-1",
        action: "store_ai_contact_consent",
        conversionAttemptId: "attempt-0002",
      },
      5_000,
    );

    expect(
      readPendingConversion(5_000 + PENDING_CONVERSION_TTL_MS),
    ).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_CONVERSION_KEY)).toBeNull();
  });

  it("keeps the stable actor and idempotency state until success or cancellation", () => {
    savePendingConversion({
      storePath: "/store-a",
      offerId: "offer-1",
      action: "contact_listing",
      conversionAttemptId: "attempt-0003",
    });

    const updated = updatePendingConversion("offer-1", {
      actorId: "00000000-0000-7000-8000-000000000010",
      intentId: "00000000-0000-7000-8000-000000000011",
      idempotencyKey: "conversion:web-contact:actor:intent:offer",
    });
    clearPendingConversion("another-offer");

    expect(readPendingConversion()).toEqual(updated);
    clearPendingConversion("offer-1");
    expect(readPendingConversion()).toBeNull();
  });

  it("rejects malformed or overlong-lived browser values", () => {
    window.sessionStorage.setItem(
      PENDING_CONVERSION_KEY,
      JSON.stringify({
        version: 1,
        storePath: "/store-a",
        offerId: "offer-1",
        action: "contact_listing",
        conversionAttemptId: "attempt-0004",
        createdAt: 1,
        expiresAt: 2 + PENDING_CONVERSION_TTL_MS,
      }),
    );

    expect(readPendingConversion(2)).toBeNull();
  });

  it("reuses one attempt across retries and creates a new attempt after cancellation", () => {
    const first = ensurePendingConversion({
      storePath: "/store-a",
      offerId: "offer-1",
      action: "contact_listing",
      conversionAttemptId: "attempt-retry-1",
    });
    const retry = ensurePendingConversion({
      storePath: "/store-a",
      offerId: "offer-1",
      action: "contact_listing",
      conversionAttemptId: "attempt-ignored",
    });
    clearPendingConversion("offer-1");
    const next = ensurePendingConversion({
      storePath: "/store-a",
      offerId: "offer-1",
      action: "contact_listing",
      conversionAttemptId: "attempt-retry-2",
    });

    expect(retry?.conversionAttemptId).toBe(first?.conversionAttemptId);
    expect(next?.conversionAttemptId).toBe("attempt-retry-2");
  });

  it("treats unavailable browser storage as a best-effort cache", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() =>
      savePendingConversion({
        storePath: "/store-a",
        offerId: "offer-1",
        action: "contact_listing",
        conversionAttemptId: "attempt-store-1",
      }),
    ).not.toThrow();
    expect(
      savePendingConversion({
        storePath: "/store-a",
        offerId: "offer-1",
        action: "contact_listing",
        conversionAttemptId: "attempt-store-1",
      }),
    ).toBeNull();
  });

  it("never throws when getItem or removeItem fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => readPendingConversion()).not.toThrow();
    expect(readPendingConversion()).toBeNull();
    expect(() => clearPendingConversion()).not.toThrow();
  });
});
