import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  anonymousAcquisitionSubject,
  recordAcquisitionLanding,
  resolveActiveAcquisitionLink,
} = vi.hoisted(() => ({
  anonymousAcquisitionSubject: vi.fn(),
  recordAcquisitionLanding: vi.fn(),
  resolveActiveAcquisitionLink: vi.fn(),
}));

vi.mock("./lib/acquisition-links", () => ({
  ACQUISITION_SUBJECT_COOKIE: "matchplane_acquisition_subject",
  ACQUISITION_SUBJECT_COOKIE_MAX_AGE: 31_536_000,
  anonymousAcquisitionSubject,
  recordAcquisitionLanding,
  resolveActiveAcquisitionLink,
}));

import { GET } from "../app/r/[token]/route";

const token = "AAAAAAAAAAAAAAAAAAAAAA";
const subjectValue = "AQEBAQEBAQEBAQEBAQEBAQ";
const subjectDigest = createHash("sha256").update(subjectValue).digest();
const link = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  domainId: "33333333-3333-4333-8333-333333333333",
  storeId: "44444444-4444-4444-8444-444444444444",
  offerId: "55555555-5555-4555-8555-555555555555",
  channelKey: "partner.referral",
  sourceRef: null,
  campaignRef: null,
};

function request(cookie?: string): Request {
  return new Request(`https://matchplane.test/r/${token}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

const context = { params: Promise.resolve({ token }) };

describe("anonymous acquisition redirect", () => {
  beforeEach(() => {
    resolveActiveAcquisitionLink.mockReset().mockResolvedValue(link);
    anonymousAcquisitionSubject.mockReset().mockReturnValue({
      value: subjectValue,
      digest: subjectDigest,
      shouldSetCookie: true,
    });
    recordAcquisitionLanding.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets a production-safe anonymous cookie, records once, and redirects to the stable visit path", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(request(), context);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/visit/${token}`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(
      `matchplane_acquisition_subject=${subjectValue}`,
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(resolveActiveAcquisitionLink).toHaveBeenCalledWith(token);
    expect(recordAcquisitionLanding).toHaveBeenCalledWith(link, subjectDigest);
  });

  it("reuses a valid cookie without emitting another Set-Cookie header", async () => {
    anonymousAcquisitionSubject.mockReturnValue({
      value: subjectValue,
      digest: subjectDigest,
      shouldSetCookie: false,
    });

    const response = await GET(
      request(`matchplane_acquisition_subject=${subjectValue}`),
      context,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(recordAcquisitionLanding).toHaveBeenCalledOnce();
  });

  it.each([
    "malformed token",
    "expired link",
    "disabled link",
    "sold offer",
    "expired offer",
    "private store",
    "inactive store",
    "disabled domain",
  ])("returns the same safe 404 without a mall fallback for %s", async () => {
    resolveActiveAcquisitionLink.mockResolvedValue(null);

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "访问链接不存在或已不可用",
    });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(anonymousAcquisitionSubject).not.toHaveBeenCalled();
    expect(recordAcquisitionLanding).not.toHaveBeenCalled();
  });

  it("collapses a touchpoint storage failure to the same non-enumerating 404", async () => {
    recordAcquisitionLanding.mockRejectedValue(new Error("storage unavailable"));

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "访问链接不存在或已不可用",
    });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
