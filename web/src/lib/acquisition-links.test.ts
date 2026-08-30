import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./auth", () => ({ authDatabase: { query: vi.fn() } }));

import {
  ACQUISITION_SUBJECT_COOKIE,
  anonymousAcquisitionSubject,
  digestAcquisitionToken,
  generateAcquisitionToken,
  isCanonicalAcquisitionToken,
  recordAcquisitionLanding,
  resolveActiveAcquisitionLink,
} from "./acquisition-links";

const rawToken = "AAAAAAAAAAAAAAAAAAAAAA";
const link = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  domainId: "33333333-3333-4333-8333-333333333333",
  storeId: "44444444-4444-4444-8444-444444444444",
  offerId: "55555555-5555-4555-8555-555555555555",
  channelKey: "partner.referral",
  sourceRef: "source-7",
  campaignRef: "campaign-9",
};

describe("acquisition link privacy helpers", () => {
  it("generates canonical 128-bit tokens and hashes the exact ASCII form", () => {
    const values = new Set(
      Array.from({ length: 32 }, () => generateAcquisitionToken()),
    );

    expect(values.size).toBe(32);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isCanonicalAcquisitionToken(value)).toBe(true);
      expect(digestAcquisitionToken(value)).toEqual(
        createHash("sha256").update(value, "ascii").digest(),
      );
    }
  });

  it.each([
    "",
    "short",
    "AAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAA!",
    "______________________",
  ])("rejects a non-canonical public token without querying (%s)", async (token) => {
    const query = vi.fn();

    expect(isCanonicalAcquisitionToken(token)).toBe(false);
    await expect(
      resolveActiveAcquisitionLink(token, { query } as never),
    ).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("reuses one valid first-party cookie and persists only its digest", () => {
    const request = new Request("https://matchplane.test/r/example", {
      headers: {
        cookie: `${ACQUISITION_SUBJECT_COOKIE}=${rawToken}`,
        "user-agent": "must-not-be-read-or-stored",
        "x-forwarded-for": "192.0.2.9",
      },
    });

    const subject = anonymousAcquisitionSubject(request);

    expect(subject).toEqual({
      value: rawToken,
      digest: createHash("sha256").update(rawToken, "ascii").digest(),
      shouldSetCookie: false,
    });
  });

  it("replaces malformed or ambiguous subject cookies with fresh entropy", () => {
    const malformed = anonymousAcquisitionSubject(
      new Request("https://matchplane.test/r/example", {
        headers: { cookie: `${ACQUISITION_SUBJECT_COOKIE}=not-canonical` },
      }),
    );
    const duplicate = anonymousAcquisitionSubject(
      new Request("https://matchplane.test/r/example", {
        headers: {
          cookie: `${ACQUISITION_SUBJECT_COOKIE}=${rawToken}; ${ACQUISITION_SUBJECT_COOKIE}=${rawToken}`,
        },
      }),
    );

    expect(malformed.shouldSetCookie).toBe(true);
    expect(duplicate.shouldSetCookie).toBe(true);
    expect(malformed.value).not.toBe("not-canonical");
    expect(duplicate.value).not.toBe(rawToken);
    expect(isCanonicalAcquisitionToken(malformed.value)).toBe(true);
    expect(isCanonicalAcquisitionToken(duplicate.value)).toBe(true);
  });

  it("resolves through every active/public/sellable scope and binds a digest", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [link] });

    await expect(
      resolveActiveAcquisitionLink(rawToken, { query } as never),
    ).resolves.toEqual(link);

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("link.status = 'active'");
    expect(sql).toContain("link.expires_at > clock_timestamp()");
    expect(sql).toContain("offer.status = 'active'");
    expect(sql).toContain("offer.expires_at > clock_timestamp()");
    expect(sql).toContain("store.status = 'active'");
    expect(sql).toContain("store.visibility = 'public'");
    expect(sql).toContain("domain.status = 'active'");
    expect(sql).toContain("tenant.status = 'active'");
    expect(parameters).toEqual([digestAcquisitionToken(rawToken)]);
    expect(JSON.stringify(parameters)).not.toContain(rawToken);
  });

  it.each([
    "expired link",
    "disabled link",
    "sold offer",
    "expired offer",
    "private store",
    "inactive store",
    "disabled domain",
  ])("fails closed when the active resolver finds no row: %s", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(
      resolveActiveAcquisitionLink(rawToken, { query } as never),
    ).resolves.toBeNull();
  });

  it("records only the bounded landing event with an idempotent conflict target", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const digest = createHash("sha256").update("anonymous").digest();

    await recordAcquisitionLanding(link, digest, { query } as never);

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'landing_viewed'");
    expect(sql).toContain(
      "ON CONFLICT (tenant_id, link_id, anonymous_subject_digest, event_type)",
    );
    expect(sql).toContain("DO NOTHING");
    expect(parameters.slice(1)).toEqual([link.tenantId, link.id, digest]);
    expect(sql).not.toMatch(/ip|user_agent|phone|wechat|metadata|payload/i);
  });
});
