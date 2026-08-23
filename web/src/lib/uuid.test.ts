import { describe, expect, it } from "vitest";

import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("accepts complete RFC 4122 and RFC 9562 UUIDs", () => {
    expect(isUuid("0633754d-cbdc-4184-9ac7-485e7380bb91")).toBe(true);
    expect(isUuid("00000000-0000-7000-8000-000000000100")).toBe(true);
  });

  it("rejects a UUID missing the final group separator", () => {
    expect(isUuid("0633754d-cbdc-4184-9ac7485e7380bb91")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});
