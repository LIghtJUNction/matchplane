import { afterEach, describe, expect, it } from "vitest";

import {
  hasTrustedBrowserOrigin,
  hasTrustedCookieOrigin,
} from "./request-origin";

const cookie = "better-auth.session_token=opaque";
const request = (
  origin?: string,
  withCookie = true,
  method: "GET" | "HEAD" | "POST" = "GET",
) =>
  new Request("http://localhost:4173/api/mutation", {
    method,
    headers: {
      ...(withCookie ? { cookie } : {}),
      ...(origin === undefined ? {} : { origin }),
    },
  });

afterEach(() => {
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
});

describe("request origin boundaries", () => {
  it("rejects cookie requests with missing, malformed, or untrusted Origin", () => {
    expect(hasTrustedCookieOrigin(request())).toBe(false);
    expect(hasTrustedCookieOrigin(request("not-an-origin"))).toBe(false);
    expect(hasTrustedCookieOrigin(request("https://evil.example"))).toBe(false);
  });

  it("accepts a configured same-origin cookie request", () => {
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "http://localhost:4173";
    expect(hasTrustedCookieOrigin(request("http://localhost:4173"))).toBe(true);
  });

  it("allows authenticated GET reads without a browser Origin header", () => {
    expect(hasTrustedBrowserOrigin(request())).toBe(true);
    expect(hasTrustedBrowserOrigin(request(undefined, true, "HEAD"))).toBe(
      true,
    );
    expect(hasTrustedBrowserOrigin(request(undefined, true, "POST"))).toBe(
      false,
    );
  });

  it("keeps no-cookie browser-origin behavior for explicit machine routes", () => {
    expect(
      hasTrustedBrowserOrigin(request("https://evil.example", false)),
    ).toBe(true);
    expect(
      hasTrustedCookieOrigin(request("http://localhost:4173", false)),
    ).toBe(false);
  });
});
