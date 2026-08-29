import { describe, expect, it, vi } from "vitest";

import { createClientUuid } from "./client-uuid";

describe("createClientUuid", () => {
  it("uses getRandomValues when randomUUID is unavailable on HTTP origins", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(7);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(createClientUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(getRandomValues).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });
});
