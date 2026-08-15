import { describe, expect, it } from "vitest";

import { hasTrustedBrowserOrigin } from "./request-origin";

describe("browser request origin boundary", () => {
  it("does not constrain API-key calls that have no browser cookie", () => {
    expect(hasTrustedBrowserOrigin(new Request("https://matx.tech/api/mcp", {
      headers: { origin: "https://evil.example" },
    }))).toBe(true);
  });

  it("rejects a cross-site origin when a Better Auth cookie is present", () => {
    expect(hasTrustedBrowserOrigin(new Request("http://localhost:4173/api/marketplace/session", {
      headers: {
        cookie: "better-auth.session_token=opaque",
        origin: "https://evil.example",
      },
    }))).toBe(false);
  });

  it("accepts the configured local development origin", () => {
    expect(hasTrustedBrowserOrigin(new Request("http://localhost:4173/api/marketplace/session", {
      headers: {
        cookie: "better-auth.session_token=opaque",
        origin: "http://localhost:4173",
      },
    }))).toBe(true);
  });
});
