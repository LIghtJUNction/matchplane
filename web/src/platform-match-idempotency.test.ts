import { describe, expect, it } from "vitest";

import { normalizeMatchIdempotencyKey } from "./platform-match-idempotency";

describe("platform match idempotency keys", () => {
  it("trims a bounded opaque retry key", () => {
    expect(normalizeMatchIdempotencyKey("  chat-123  ")).toBe("chat-123");
  });

  it("allows an omitted key but rejects unsafe or oversized values", () => {
    expect(normalizeMatchIdempotencyKey(undefined)).toBeNull();
    expect(normalizeMatchIdempotencyKey("\u0000bad")).toBeNull();
    expect(normalizeMatchIdempotencyKey("x".repeat(241))).toBeNull();
    expect(normalizeMatchIdempotencyKey({})).toBeNull();
  });
});
