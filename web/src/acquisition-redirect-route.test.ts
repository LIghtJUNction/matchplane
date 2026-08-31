import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  AcquisitionStorageError,
  anonymousAcquisitionSubject,
  recordAcquisitionLanding,
  resolveActiveAcquisitionLink,
} = vi.hoisted(() => {
  class AcquisitionStorageError extends Error {}
  return {
    AcquisitionStorageError,
    anonymousAcquisitionSubject: vi.fn(),
    recordAcquisitionLanding: vi.fn(),
    resolveActiveAcquisitionLink: vi.fn(),
  };
});

vi.mock("./lib/acquisition-links", () => ({
  ACQUISITION_SUBJECT_COOKIE: "matchplane_acquisition_subject",
  ACQUISITION_SUBJECT_COOKIE_MAX_AGE: 31_536_000,
  AcquisitionStorageError,
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
    recordAcquisitionLanding.mockReset().mockResolvedValue("recorded");
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("keeps a reused valid cookie idempotent without emitting Set-Cookie", async () => {
    anonymousAcquisitionSubject.mockReturnValue({
      value: subjectValue,
      digest: subjectDigest,
      shouldSetCookie: false,
    });
    recordAcquisitionLanding
      .mockResolvedValueOnce("recorded")
      .mockResolvedValueOnce("duplicate");

    const first = await GET(
      request(`matchplane_acquisition_subject=${subjectValue}`),
      context,
    );
    const second = await GET(
      request(`matchplane_acquisition_subject=${subjectValue}`),
      context,
    );

    expect(first.status).toBe(307);
    expect(second.status).toBe(307);
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(recordAcquisitionLanding).toHaveBeenCalledTimes(2);
    expect(recordAcquisitionLanding).toHaveBeenNthCalledWith(
      1,
      link,
      subjectDigest,
    );
    expect(recordAcquisitionLanding).toHaveBeenNthCalledWith(
      2,
      link,
      subjectDigest,
    );
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

  it("still redirects when the link has reached its UTC-day analytics capacity", async () => {
    recordAcquisitionLanding.mockResolvedValue("daily_capacity_reached");

    const response = await GET(request(), context);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/visit/${token}`);
    expect(response.headers.get("set-cookie")).toContain(subjectValue);
  });

  it("still redirects after a transient analytics failure and logs no identifiers", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordAcquisitionLanding.mockRejectedValue(
      new AcquisitionStorageError("storage unavailable"),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/visit/${token}`);
    expect(response.headers.get("set-cookie")).toContain(subjectValue);
    expect(warning).toHaveBeenCalledWith(
      "acquisition touchpoint storage unavailable",
    );
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(subjectValue);
    expect(logged).not.toContain(link.id);
  });

  it("keeps acquisition resolution storage failures on the safe 404 path", async () => {
    resolveActiveAcquisitionLink.mockRejectedValue(
      new AcquisitionStorageError("storage unavailable"),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(recordAcquisitionLanding).not.toHaveBeenCalled();
  });

  it("does not swallow programming errors after a link has resolved", async () => {
    recordAcquisitionLanding.mockRejectedValue(
      new TypeError("unexpected analytics result"),
    );

    await expect(GET(request(), context)).rejects.toThrow(
      "unexpected analytics result",
    );
  });
});
