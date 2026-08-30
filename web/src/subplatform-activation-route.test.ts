import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, getSession, release, rootQuery, transactionQuery } =
  vi.hoisted(() => ({
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
  store: "623e4567-e89b-42d3-a456-426614174000",
};
const buildDigest = "a".repeat(64);

function cameraManifest(
  field: Record<string, unknown> = { key: "model", label: "Model" },
) {
  return {
    productTemplates: [
      {
        id: "camera",
        label: "Camera",
        supplyFields: [field],
      },
    ],
  };
}

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
  current?: { id: string; version: string; manifest?: unknown } | null;
  store?: { storeId: string } | null;
  references?: Array<string | null>;
  stabilityChecked?: boolean;
  activated?: boolean;
}) {
  const target = input.target ?? registration();
  const current = input.current
    ? { ...input.current, manifest: input.current.manifest ?? {} }
    : null;
  const store =
    input.store === undefined ? { storeId: ids.store } : input.store;
  transactionQuery
    .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
    .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // advisory lock
    .mockResolvedValueOnce({ rowCount: 1, rows: [target] }) // target FOR UPDATE
    .mockResolvedValueOnce({
      rowCount: current ? 1 : 0,
      rows: current ? [current] : [],
    }); // current active
  if (input.stabilityChecked !== false) {
    transactionQuery.mockResolvedValueOnce({
      rowCount: store ? 1 : 0,
      rows: store ? [store] : [],
    }); // canonical store FOR UPDATE
    if (store) {
      const references = (input.references ?? []).map((productTemplateId) => ({
        productTemplateId,
      }));
      transactionQuery.mockResolvedValueOnce({
        rowCount: references.length,
        rows: references,
      });
    }
  }
  if (input.activated !== false) {
    transactionQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: ids.registration,
            slug: "demo-store",
            state: "active",
            version: target.version,
            buildDigest,
            manifestDigest: "b".repeat(64),
            tenantId: ids.tenant,
            domainId: ids.domain,
          },
        ],
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
    await expect(response.json()).resolves.toMatchObject({
      id: ids.registration,
      state: "active",
      routing: "enabled",
    });
    expect(transactionQuery.mock.calls[1]?.[0]).toContain(
      "pg_advisory_xact_lock",
    );
    expect(transactionQuery.mock.calls[1]?.[1]).toEqual([
      ids.tenant,
      "demo-store",
    ]);

    expect(transactionQuery.mock.calls[3]?.[1]).toEqual([
      ids.tenant,
      "demo-store",
      ids.domain,
    ]);
    expect(transactionQuery.mock.calls[4]?.[0]).toContain("FOR UPDATE");
    expect(transactionQuery.mock.calls[4]?.[1]).toEqual([
      ids.tenant,
      ids.domain,
      target.organizationId,
    ]);
    expect(transactionQuery.mock.calls[5]?.[0]).toContain(
      "store_id = $3::uuid",
    );
    expect(transactionQuery.mock.calls[5]?.[1]).toEqual([
      ids.tenant,
      ids.domain,
      ids.store,
      17,
    ]);

    const activation = transactionQuery.mock.calls[6];
    expect(activation?.[0]).toContain("SET state = 'active'");
    expect(activation?.[0]).not.toContain("version = version + 1");
    expect(activation?.[1]).toEqual([ids.registration, "9", buildDigest]);

    const retirement = transactionQuery.mock.calls[7];
    expect(retirement?.[0]).toContain("AND version < $4::bigint");
    expect(retirement?.[1]).toEqual([
      ids.tenant,
      "demo-store",
      ids.registration,
      "9",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("allows a newer release when every referenced template keeps the normalized supply-field definition", async () => {
    const currentManifest = cameraManifest({ key: "model", label: "Model" });
    const targetManifest = cameraManifest({
      key: "model",
      label: "Model",
      type: "text",
      required: false,
    });
    const target = registration({ manifest: targetManifest });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: {
        id: ids.olderRegistration,
        version: "8",
        manifest: currentManifest,
      },
      references: ["camera"],
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET state = 'active'"),
      ),
    ).toBe(true);
  });

  it("rejects changing the normalized supply-field definition of a referenced template", async () => {
    const target = registration({
      manifest: cameraManifest({
        key: "model",
        label: "Model",
        type: "textarea",
      }),
    });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: {
        id: ids.olderRegistration,
        version: "8",
        manifest: cameraManifest(),
      },
      references: ["camera"],
      activated: false,
    });
    transactionQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "目标版本修改了仍被店铺供给引用的商品模板定义：camera",
    });
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET state = 'active'"),
      ),
    ).toBe(false);
  });

  it("rejects deleting a template ID still referenced by the canonical store", async () => {
    const target = registration({
      manifest: {
        productTemplates: [{ id: "lens", label: "Lens", supplyFields: [] }],
      },
    });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: {
        id: ids.olderRegistration,
        version: "8",
        manifest: cameraManifest(),
      },
      references: ["camera"],
      activated: false,
    });
    transactionQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "目标版本缺少仍被店铺供给引用的商品模板：camera",
    });
  });

  it("rejects switching legacy offers with null bindings to product templates", async () => {
    const target = registration({ manifest: cameraManifest() });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: { id: ids.olderRegistration, version: "8", manifest: {} },
      references: [null],
      activated: false,
    });
    transactionQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "店铺仍有未绑定商品模板的历史供给，请先显式迁移后再激活商品模板目录",
    });
  });

  it("rejects switching back to a legacy manifest while template bindings remain", async () => {
    const target = registration({ manifest: {} });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: {
        id: ids.olderRegistration,
        version: "8",
        manifest: cameraManifest(),
      },
      references: ["camera"],
      activated: false,
    });
    transactionQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "目标版本不能切回 legacy manifest：店铺供给仍引用商品模板",
    });
  });

  it("rejects a target release that is not strictly newer than the current active release", async () => {
    const target = registration({ version: "8" });
    rootQuery.mockResolvedValue({ rowCount: 1, rows: [target] });
    transactionResults({
      target,
      current: { id: ids.olderRegistration, version: "8" },
      stabilityChecked: false,
      activated: false,
    });
    transactionQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "目标注册版本必须严格新于当前激活版本",
    });
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET state = 'active'"),
      ),
    ).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
