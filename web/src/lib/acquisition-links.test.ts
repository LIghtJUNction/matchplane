import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./auth", () => ({ authDatabase: { query: vi.fn() } }));

import {
  ACQUISITION_SUBJECT_COOKIE,
  ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT,
  AcquisitionStorageError,
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

  it("wraps resolver database failures without putting the raw token in the error", async () => {
    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));

    const failure = await resolveActiveAcquisitionLink(rawToken, {
      query,
    } as never).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AcquisitionStorageError);
    expect(String(failure)).not.toContain(rawToken);
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
    expect(sql).toContain("registration.state = 'active'");
    expect(sql).toContain("store.integration_kind = 'hosted'");
    expect(sql).toContain("store.integration_kind <> 'external'");
    expect(sql).toContain("registration.source_kind <> 'remote'");
    expect(sql).toContain("binding.status = 'active'");
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
    "inactive package registration",
    "unbound external store",
    "unbound remote package",
  ])("fails closed when the active resolver finds no row: %s", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(
      resolveActiveAcquisitionLink(rawToken, { query } as never),
    ).resolves.toBeNull();
  });

  it("records only the bounded landing event after taking a transaction-scoped day lock", async () => {
    const digest = createHash("sha256").update("anonymous").digest();
    const occurredAt = new Date("2026-08-31T12:00:00.000Z");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ occurredAt, occurredOn: "2026-08-31" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ inserted: true }] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] });
    const release = vi.fn();

    await expect(
      recordAcquisitionLanding(link, digest, {
        connect: vi.fn().mockResolvedValue({ query, release }),
      } as never),
    ).resolves.toBe("recorded");

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      expect.stringContaining("clock_timestamp"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("WITH inserted AS"),
      "COMMIT",
    ]);
    const [lockSql, lockParameters] = query.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(lockSql).toContain("hashtextextended");
    expect(lockParameters).toEqual([link.id, "2026-08-31"]);

    const [insertSql, insertParameters] = query.mock.calls[3] as [
      string,
      unknown[],
    ];
    expect(insertSql).toContain("'landing_viewed'");
    expect(insertSql).toContain("existing.occurred_on = $6::date");
    expect(insertSql).toContain("< $7::bigint");
    expect(insertSql).toContain(
      "ON CONFLICT (tenant_id, link_id, anonymous_subject_digest, event_type)",
    );
    expect(insertSql).toContain("DO NOTHING");
    expect(insertParameters.slice(1)).toEqual([
      link.tenantId,
      link.id,
      digest,
      occurredAt,
      "2026-08-31",
      ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT,
    ]);
    expect(insertSql).not.toMatch(
      /ip_address|user_agent|referer|user_id|phone|wechat|metadata|payload/i,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("serializes concurrent writers so the per-link UTC-day cap cannot be exceeded", async () => {
    const storage = cappedLandingDatabase(
      ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT - 1,
    );
    const firstDigest = createHash("sha256").update("robot-one").digest();
    const secondDigest = createHash("sha256").update("robot-two").digest();

    const outcomes = await Promise.all([
      recordAcquisitionLanding(link, firstDigest, storage.database as never),
      recordAcquisitionLanding(link, secondDigest, storage.database as never),
    ]);

    expect(outcomes.sort()).toEqual(["daily_capacity_reached", "recorded"]);
    expect(storage.count()).toBe(
      ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT,
    );
  });

  it("keeps a reused anonymous cookie idempotent at link+subject+event scope", async () => {
    const storage = cappedLandingDatabase(0);
    const cookieDigest = digestAcquisitionToken(rawToken);

    await expect(
      recordAcquisitionLanding(link, cookieDigest, storage.database as never),
    ).resolves.toBe("recorded");
    await expect(
      recordAcquisitionLanding(link, cookieDigest, storage.database as never),
    ).resolves.toBe("duplicate");
    expect(storage.count()).toBe(1);
  });

  it("wraps query failures in a bounded token-free storage error", async () => {
    const digest = digestAcquisitionToken(rawToken);
    const query = vi
      .fn()
      .mockResolvedValue({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockRejectedValueOnce(new Error("database unavailable"));

    const result = recordAcquisitionLanding(link, digest, {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never);

    await expect(result).rejects.toBeInstanceOf(AcquisitionStorageError);
    await expect(result).rejects.not.toThrow(rawToken);
  });
});

function cappedLandingDatabase(initialCount: number) {
  let persistedCount = initialCount;
  const persistedSubjects = new Set<string>();
  let lockTail = Promise.resolve();

  const database = {
    async connect() {
      let stagedSubject: string | null = null;
      let releaseDayLock: (() => void) | null = null;

      return {
        async query(sql: string, parameters: unknown[] = []) {
          if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED") {
            return { rowCount: null, rows: [] };
          }
          if (sql.includes("event_clock.occurred_at")) {
            return {
              rowCount: 1,
              rows: [
                {
                  occurredAt: new Date("2026-08-31T12:00:00.000Z"),
                  occurredOn: "2026-08-31",
                },
              ],
            };
          }
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = lockTail;
            let release!: () => void;
            lockTail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
            releaseDayLock = release;
            return { rowCount: 1, rows: [{}] };
          }
          if (sql.includes("WITH inserted AS")) {
            const digest = parameters[3];
            if (!Buffer.isBuffer(digest)) {
              throw new TypeError("test storage expected a digest buffer");
            }
            const subject = digest.toString("hex");
            const inserted =
              !persistedSubjects.has(subject) &&
              persistedCount <
                ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT;
            if (inserted) stagedSubject = subject;
            return { rowCount: 1, rows: [{ inserted }] };
          }
          if (sql.includes(") AS duplicate")) {
            const digest = parameters[2];
            if (!Buffer.isBuffer(digest)) {
              throw new TypeError("test storage expected a digest buffer");
            }
            return {
              rowCount: 1,
              rows: [{ duplicate: persistedSubjects.has(digest.toString("hex")) }],
            };
          }
          if (sql === "COMMIT") {
            if (stagedSubject !== null) {
              persistedSubjects.add(stagedSubject);
              persistedCount += 1;
            }
            releaseDayLock?.();
            releaseDayLock = null;
            return { rowCount: null, rows: [] };
          }
          if (sql === "ROLLBACK") {
            releaseDayLock?.();
            releaseDayLock = null;
            return { rowCount: null, rows: [] };
          }
          throw new TypeError(`unexpected test query: ${sql}`);
        },
        release() {},
      };
    },
  };

  return { database, count: () => persistedCount };
}
