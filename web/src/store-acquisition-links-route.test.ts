import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connect,
  getSession,
  hasTrustedBrowserOrigin,
  query,
  readStoreAccess,
  release,
  transactionQuery,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  query: vi.fn(),
  readStoreAccess: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { connect, query },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/store-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/store-access")>();
  return { ...original, readStoreAccess };
});

import {
  GET,
  PATCH,
  POST,
} from "../app/api/stores/[storeId]/acquisition-links/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const offerId = "44444444-4444-4444-8444-444444444444";
const linkId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";
const context = { params: Promise.resolve({ storeId }) };

const activeLink = {
  id: linkId,
  offerId,
  channelKey: "partner.referral",
  sourceRef: "source-a",
  campaignRef: "campaign-b",
  configuredStatus: "active",
  expiresAt: "2999-09-01T00:00:00.000Z",
  expired: false,
  version: "1",
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

function request(
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Request {
  return new Request(
    `https://matchplane.test/api/stores/${storeId}/acquisition-links`,
    {
      method,
      headers: {
        origin: "https://matchplane.test",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    offerId,
    channelKey: "partner.referral",
    sourceRef: " source-a ",
    campaignRef: "campaign-b",
    expiresAt: "2999-09-01T00:00:00Z",
    ...overrides,
  };
}

function patchBody(overrides: Record<string, unknown> = {}) {
  return {
    linkId,
    status: "disabled",
    expectedVersion: 1,
    ...overrides,
  };
}

function defaultTransactionImplementation() {
  transactionQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT offer.id::text")) {
      return { rowCount: 1, rows: [{ id: offerId }] };
    }
    if (sql.includes("INSERT INTO marketplace_acquisition_links")) {
      return { rowCount: 1, rows: [activeLink] };
    }
    if (sql.includes("FOR UPDATE")) {
      return { rowCount: 1, rows: [activeLink] };
    }
    if (sql.includes("UPDATE marketplace_acquisition_links")) {
      return {
        rowCount: 1,
        rows: [
          {
            ...activeLink,
            configuredStatus: "disabled",
            version: "2",
            updatedAt: "2026-08-30T08:01:00.000Z",
          },
        ],
      };
    }
    return { rowCount: 1, rows: [] };
  });
}

describe("store acquisition links API", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", tenantId);
    getSession.mockReset().mockResolvedValue({ user: { id: userId } });
    hasTrustedBrowserOrigin.mockReset().mockReturnValue(true);
    query.mockReset();
    readStoreAccess.mockReset().mockResolvedValue({
      store: {
        id: storeId,
        tenantId,
        slug: "store-example",
        path: "/store-example",
        displayName: "Example Store",
        description: "",
        integrationKind: "hosted",
        status: "active",
        version: 1,
        domainId,
        organizationId: "77777777-7777-4777-8777-777777777777",
        metadata: {},
        currentRegistrationId: null,
      },
      canOperate: true,
      canManageStore: true,
    });
    release.mockReset();
    transactionQuery.mockReset();
    defaultTransactionImplementation();
    connect.mockReset().mockResolvedValue({
      query: transactionQuery,
      release,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a scoped link, stores only its SHA-256 digest, and returns the token once", async () => {
    const response = await POST(request("POST", createBody()), context);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      link: Record<string, unknown>;
      shortPath: string;
    };
    expect(body.link).toMatchObject({
      id: linkId,
      offerId,
      channelKey: "partner.referral",
      sourceRef: "source-a",
      campaignRef: "campaign-b",
      status: "active",
      active: true,
      version: 1,
    });
    expect(body.shortPath).toMatch(/^\/r\/[A-Za-z0-9_-]{22}$/);
    const rawToken = body.shortPath.slice(3);

    const scopeCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT offer.id::text"),
    ) as [string, unknown[]];
    expect(scopeCall[0]).toContain("offer.tenant_id = $1::uuid");
    expect(scopeCall[0]).toContain("offer.store_id = $2::uuid");
    expect(scopeCall[0]).toContain("offer.domain_id = $3::uuid");
    expect(scopeCall[1]).toEqual([tenantId, storeId, domainId, offerId]);

    const insertCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO marketplace_acquisition_links"),
    ) as [string, unknown[]];
    expect(insertCall[1]).not.toContain(rawToken);
    expect(insertCall[1][5]).toEqual(
      createHash("sha256").update(rawToken, "ascii").digest(),
    );
    expect(insertCall[1].slice(6)).toEqual([
      "partner.referral",
      "source-a",
      "campaign-b",
      "2999-09-01T00:00:00.000Z",
    ]);
    const auditCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("platform_audit_events"),
    );
    expect(JSON.stringify(auditCall)).not.toContain(rawToken);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("lists safe metadata without returning a raw token or digest and marks expiry effectively", async () => {
    query.mockResolvedValue({
      rowCount: 1,
      rows: [{ ...activeLink, expired: true }],
    });

    const response = await GET(request("GET"), context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      links: [
        {
          id: linkId,
          offerId,
          channelKey: "partner.referral",
          sourceRef: "source-a",
          campaignRef: "campaign-b",
          status: "expired",
          active: false,
          expiresAt: "2999-09-01T00:00:00.000Z",
          version: 1,
          createdAt: "2026-08-30T08:00:00.000Z",
          updatedAt: "2026-08-30T08:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/token|digest/i);
    expect(query.mock.calls[0]?.[0]).not.toContain("token_digest");
  });

  it("requires an authenticated Better Auth session", async () => {
    getSession.mockResolvedValue(null);

    const response = await GET(request("GET"), context);

    expect(response.status).toBe(401);
    expect(readStoreAccess).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects ordinary store operators for every management method", async () => {
    readStoreAccess.mockResolvedValue({
      store: { id: storeId, tenantId },
      canOperate: true,
      canManageStore: false,
    });

    for (const [method, body] of [
      ["GET", undefined],
      ["POST", createBody()],
      ["PATCH", patchBody()],
    ] as const) {
      const response = await (
        method === "GET" ? GET : method === "POST" ? POST : PATCH
      )(request(method, body), context);
      expect(response.status).toBe(403);
    }
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an offer outside the canonical tenant/store/domain before minting a response token", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT offer.id::text")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await POST(request("POST", createBody()), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "商品不属于当前店铺" });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO marketplace_acquisition_links"),
    )).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rolls back an audit failure without returning a raw token", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT offer.id::text")) {
        return { rowCount: 1, rows: [{ id: offerId }] };
      }
      if (sql.includes("INSERT INTO marketplace_acquisition_links")) {
        return { rowCount: 1, rows: [activeLink] };
      }
      if (sql.includes("platform_audit_events")) {
        throw new Error("audit unavailable");
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await POST(request("POST", createBody()), context);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "渠道链接创建失败，请稍后重试" });
    expect(JSON.stringify(body)).not.toContain("/r/");
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("does not leak a newly minted token when a concurrent digest insert conflicts", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT offer.id::text")) {
        return { rowCount: 1, rows: [{ id: offerId }] };
      }
      if (sql.includes("INSERT INTO marketplace_acquisition_links")) {
        throw new Error("duplicate key value violates unique constraint");
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await POST(request("POST", createBody()), context);
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain("/r/");
    expect(responseText).not.toMatch(/[A-Za-z0-9_-]{22}/);
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("platform_audit_events"),
      ),
    ).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it.each([
    [createBody({ offerId: "not-a-uuid" }), "商品编号必须是 UUID"],
    [createBody({ channelKey: "Uppercase" }), "channelKey"],
    [createBody({ channelKey: `a${"b".repeat(64)}` }), "channelKey"],
    [createBody({ sourceRef: "x".repeat(129) }), "sourceRef"],
    [createBody({ campaignRef: "campaign\nunsafe" }), "campaignRef"],
    [createBody({ expiresAt: "yesterday" }), "expiresAt"],
    [createBody({ unexpected: "field" }), "不支持的字段"],
  ])("enforces create field bounds: %#", async (body, message) => {
    const response = await POST(request("POST", body), context);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(message);
    expect(connect).not.toHaveBeenCalled();
  });

  it("enforces the 16 KiB mutation body limit", async () => {
    const response = await POST(
      request("POST", createBody({ sourceRef: "x".repeat(17_000) })),
      context,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "请求体不能超过 16 KiB" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires a trusted browser origin before authentication or mutation", async () => {
    hasTrustedBrowserOrigin.mockReturnValue(false);

    const response = await POST(request("POST", createBody()), context);

    expect(response.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("disables a link under a lock and commits its audit atomically", async () => {
    const response = await PATCH(request("PATCH", patchBody()), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      link: {
        id: linkId,
        offerId,
        channelKey: "partner.referral",
        sourceRef: "source-a",
        campaignRef: "campaign-b",
        status: "disabled",
        active: false,
        expiresAt: "2999-09-01T00:00:00.000Z",
        version: 2,
        createdAt: "2026-08-30T08:00:00.000Z",
        updatedAt: "2026-08-30T08:01:00.000Z",
      },
    });
    const updateCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE marketplace_acquisition_links"),
    ) as [string, unknown[]];
    expect(updateCall[1]).toEqual([tenantId, storeId, linkId, "disabled", 1]);
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("store.acquisition_link.status_updated"),
      ),
    ).toBe(true);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("does not re-enable an expired link or report it as active", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ ...activeLink, expired: true }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await PATCH(
      request("PATCH", patchBody({ status: "active" })),
      context,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "已过期的渠道链接不能重新启用",
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE marketplace_acquisition_links"),
    )).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects a stale concurrent status update", async () => {
    const response = await PATCH(
      request("PATCH", patchBody({ expectedVersion: 9 })),
      context,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "渠道链接已被其他操作更新，请刷新后重试",
    });
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it.each([
    [patchBody({ linkId: "not-a-uuid" }), "渠道链接编号"],
    [patchBody({ status: "expired" }), "status"],
    [patchBody({ expectedVersion: 0 }), "版本"],
    [patchBody({ extra: true }), "不支持的字段"],
  ])("enforces patch field bounds: %#", async (body, message) => {
    const response = await PATCH(request("PATCH", body), context);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(message);
    expect(connect).not.toHaveBeenCalled();
  });
});
