import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, getSession, release, rootQuery, transactionQuery } = vi.hoisted(() => ({
  connect: vi.fn(),
  getSession: vi.fn(),
  release: vi.fn(),
  rootQuery: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { connect, query: rootQuery },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: vi.fn(() => true),
}));
vi.mock("./lib/runtime", () => ({
  isProductionEnvironment: vi.fn(() => false),
}));
vi.mock("./platform-agent-tool", () => ({
  probeSubplatformMcpEndpoint: vi.fn(),
  readSubplatformMcpEndpoint: vi.fn(),
  validateSubplatformMcpEndpointUrl: vi.fn(),
}));

import { POST } from "../app/api/platform/subplatforms/activate/route";

const ids = {
  registration: "123e4567-e89b-42d3-a456-426614174000",
  olderRegistration: "123e4567-e89b-42d3-a456-426614174001",
  tenant: "223e4567-e89b-42d3-a456-426614174000",
  domain: "323e4567-e89b-42d3-a456-426614174000",
  user: "423e4567-e89b-42d3-a456-426614174000",
};
const buildDigest = "a".repeat(64);

function registration(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ids.registration,
    slug: "demo-store",
    state: "ready",
    version: "9",
    buildDigest,
    manifestDigest: "b".repeat(64),
    tenantId: ids.tenant,
    domainId: ids.domain,
    organizationId: "523e4567-e89b-42d3-a456-426614174000",
    parentOrganizationId: null,
    manifest: {},
    mcpServerKey: "demo-store",
    ...overrides,
  };
}

function request(): Request {
  return new Request("https://matx.test/api/platform/subplatforms/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ registrationId: ids.registration, buildDigest }),
  });
}

function transactionResults(input: {
  target?: Record<string, unknown>;
  current?: { id: string; version: string } | null;
  activated?: boolean;
}) {
  const target = input.target ?? registration();
  transactionQuery
    .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // advisory lock
    .mockResolvedValueOnce({ rowCount: 1, rows: [target] }) // target FOR UPDATE
    .mockResolvedValueOnce({ rowCount: input.current ? 1 : 0, rows: input.current ? [input.current] : [] }); // current active
  if (input.activated !== false) {
    transactionQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: ids.registration,
          slug: "demo-store",
          state: "active",
          version: target.version,
          buildDigest,
          manifestDigest: "b".repeat(64),
          tenantId: ids.tenant,
          domainId: ids.domain,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // disable only older active releases
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT
  }
}

describe("subplatform activation release ordering", () => {
  beforeEach(() => {
    connect.mockReset();
    getSession.mockReset();
    release.mockReset();
    rootQuery.mockReset();
    transactionQuery.mockReset();
    getSession.mockResolvedValue({ user: { id: ids.user, role: "rootAdmin" } });
    connect.mockResolvedValue({ query: transactionQuery, release });
  });

  it("locks the tenant/slug, preserves the target release version, then retires only older active releases", async () => {
    const target = registration({ version: "9" });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: { id: ids.olderRegistration, version: "8" },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: ids.registration, state: "active", routing: "enabled" });
    expect(transactionQuery.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
    expect(transactionQuery.mock.calls[1]?.[1]).toEqual([ids.tenant, "demo-store"]);

    const activation = transactionQuery.mock.calls[4];
    expect(activation?.[0]).toContain("SET state = 'active'");
    expect(activation?.[0]).not.toContain("version = version + 1");
    expect(activation?.[1]).toEqual([ids.registration, "9", buildDigest]);

    const retirement = transactionQuery.mock.calls[5];
    expect(retirement?.[0]).toContain("AND version < $4::bigint");
    expect(retirement?.[1]).toEqual([ids.tenant, "demo-store", ids.registration, "9"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a target release that is not strictly newer than the current active release", async () => {
    const target = registration({ version: "8" });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: { id: ids.olderRegistration, version: "8" },
      activated: false,
    });
    transactionQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "目标注册版本必须严格新于当前激活版本" });
    expect(transactionQuery.mock.calls.some(([sql]) => String(sql).includes("SET state = 'active'"))).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
