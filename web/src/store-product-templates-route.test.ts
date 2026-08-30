import { beforeEach, describe, expect, it, vi } from "vitest";

import { createProductTemplateCatalog } from "./lib/store-product-template-settings";

const {
  connect,
  getSession,
  hasTrustedBrowserOrigin,
  poolQuery,
  readStoreAccess,
  transactionQuery,
  release,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  poolQuery: vi.fn(),
  readStoreAccess: vi.fn(),
  transactionQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query: poolQuery, connect },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/store-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/store-access")>();
  return {
    ...original,
    configuredTenantId: () => "11111111-1111-4111-8111-111111111111",
    readStoreAccess,
  };
});

import {
  GET,
  PATCH,
} from "../app/api/stores/[storeId]/product-templates/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const registrationId = "44444444-4444-4444-8444-444444444444";
const manifest = {
  apiVersion: "matchplane.subplatform/v1",
  id: "mountain-shop",
  productTemplates: [
    {
      id: "standard",
      label: "标准商品",
      description: "普通现货",
      category: "general",
      supplyFields: [
        { key: "material", label: "材质", type: "text" },
      ],
    },
    {
      id: "made.to-order",
      label: "定制商品",
      category: "custom",
      supplyFields: [
        { key: "material", label: "材质", type: "text" },
        { key: "lead_time", label: "交付周期", type: "text" },
      ],
    },
  ],
  defaultProductTemplateId: "standard",
};
const revision = createProductTemplateCatalog(
  manifest,
  registrationId,
  manifest.productTemplates,
  "standard",
).revision;
const store = {
  id: storeId,
  tenantId,
  slug: "mountain-shop",
  path: "/mountain-shop",
  displayName: "山里杂货铺",
  description: "手作与山货",
  integrationKind: "package" as const,
  status: "active" as const,
  version: 1,
  domainId: "55555555-5555-4555-8555-555555555555",
  organizationId: "66666666-6666-4666-8666-666666666666",
  metadata: { unrelated: { keep: true } },
  currentRegistrationId: registrationId,
};
const context = { params: Promise.resolve({ storeId }) };

function getRequest(): Request {
  return new Request(
    `https://matchplane.test/api/stores/${storeId}/product-templates`,
  );
}

function patchRequest(
  body: Record<string, unknown> = {
    enabledTemplateIds: ["standard"],
    defaultTemplateId: "standard",
    expectedStoreVersion: 1,
    expectedCatalogRevision: revision,
  },
): Request {
  return new Request(
    `https://matchplane.test/api/stores/${storeId}/product-templates`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://matchplane.test",
      },
      body: JSON.stringify(body),
    },
  );
}

function installSuccessfulTransaction(overrides?: {
  lockedStore?: typeof store;
  auditFailure?: boolean;
}): void {
  transactionQuery.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes("FOR UPDATE")) {
      return { rowCount: 1, rows: [overrides?.lockedStore ?? store] };
    }
    if (sql.includes("JOIN subplatform_registrations")) {
      return { rowCount: 1, rows: [{ manifest, registrationId }] };
    }
    if (sql.includes("UPDATE stores store")) {
      return { rowCount: 1, rows: [{ version: 2 }] };
    }
    if (sql.includes("INSERT INTO platform_audit_events")) {
      if (overrides?.auditFailure) throw new Error("audit unavailable");
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

describe("store product templates route", () => {
  beforeEach(() => {
    connect.mockReset();
    getSession.mockReset();
    hasTrustedBrowserOrigin.mockReset();
    poolQuery.mockReset();
    readStoreAccess.mockReset();
    transactionQuery.mockReset();
    release.mockReset();
    connect.mockResolvedValue({ query: transactionQuery, release });
    getSession.mockResolvedValue({ user: { id: userId, role: "user" } });
    hasTrustedBrowserOrigin.mockReturnValue(true);
    readStoreAccess.mockResolvedValue({
      store,
      canOperate: true,
      canManageStore: true,
    });
    poolQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{ manifest, registrationId }],
    });
  });

  it("requires a session and store operation permission for GET", async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await GET(getRequest(), context)).status).toBe(401);

    getSession.mockResolvedValueOnce({ user: { id: userId } });
    readStoreAccess.mockResolvedValueOnce({
      store,
      canOperate: false,
      canManageStore: false,
    });
    expect((await GET(getRequest(), context)).status).toBe(403);
  });

  it("lets an operator read catalog defaults without leaking store metadata", async () => {
    readStoreAccess.mockResolvedValue({
      store,
      canOperate: true,
      canManageStore: false,
    });

    const response = await GET(getRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      catalog: {
        revision,
        registrationId,
        templates: manifest.productTemplates,
        defaultTemplateId: "standard",
      },
      settings: {
        enabledTemplateIds: ["standard", "made.to-order"],
        defaultTemplateId: "standard",
      },
      storeVersion: 1,
      canManageStore: false,
    });
    expect(JSON.stringify(body)).not.toContain("unrelated");
    expect(JSON.stringify(body)).not.toContain("keep");
  });

  it("returns a stable empty catalog for a hosted store with no registration", async () => {
    readStoreAccess.mockResolvedValue({
      store: {
        ...store,
        integrationKind: "hosted",
        currentRegistrationId: null,
      },
      canOperate: true,
      canManageStore: true,
    });

    const first = await (await GET(getRequest(), context)).json();
    const second = await (await GET(getRequest(), context)).json();

    expect(first.catalog).toMatchObject({
      registrationId: null,
      templates: [],
      defaultTemplateId: null,
    });
    expect(first.catalog.revision).toBe(second.catalog.revision);
    expect(first.settings).toEqual({
      enabledTemplateIds: [],
      defaultTemplateId: null,
    });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("allows an owner to update only metadata.product_templates and audits atomically", async () => {
    installSuccessfulTransaction();

    const response = await PATCH(patchRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      settings: {
        enabledTemplateIds: ["standard"],
        defaultTemplateId: "standard",
      },
      storeVersion: 2,
      canManageStore: true,
    });
    const updateCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE stores store"),
    );
    expect(updateCall?.[0]).toContain("jsonb_set");
    expect(updateCall?.[0]).toContain("store.metadata");
    expect(updateCall?.[0]).toContain("'{product_templates}'");
    expect(JSON.parse(String(updateCall?.[1]?.[2]))).toEqual({
      schema_version: 1,
      enabled_template_ids: ["standard"],
      default_template_id: "standard",
    });
    const auditCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO platform_audit_events"),
    );
    expect(auditCall?.[0]).toContain("store.product_templates.updated");
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("lets an owner explicitly disable new products with an empty set", async () => {
    installSuccessfulTransaction();

    const response = await PATCH(
      patchRequest({
        enabledTemplateIds: [],
        defaultTemplateId: null,
        expectedStoreVersion: 1,
        expectedCatalogRevision: revision,
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).settings).toEqual({
      enabledTemplateIds: [],
      defaultTemplateId: null,
    });
  });

  it("rejects anonymous/operator PATCH, untrusted origin and oversized bodies", async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await PATCH(patchRequest(), context)).status).toBe(401);

    readStoreAccess.mockResolvedValueOnce({
      store,
      canOperate: true,
      canManageStore: false,
    });
    expect((await PATCH(patchRequest(), context)).status).toBe(403);
    expect(connect).not.toHaveBeenCalled();

    hasTrustedBrowserOrigin.mockReturnValueOnce(false);
    expect((await PATCH(patchRequest(), context)).status).toBe(403);

    const oversized = patchRequest({ padding: "x".repeat(17 * 1024) });
    expect((await PATCH(oversized, context)).status).toBe(413);
  });

  it("rejects invalid IDs and default-template combinations", async () => {
    expect(
      (
        await PATCH(
          patchRequest({
            enabledTemplateIds: ["Not Valid"],
            defaultTemplateId: "Not Valid",
            expectedStoreVersion: 1,
            expectedCatalogRevision: revision,
          }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PATCH(
          patchRequest({
            enabledTemplateIds: ["standard"],
            defaultTemplateId: null,
            expectedStoreVersion: 1,
            expectedCatalogRevision: revision,
          }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects valid-looking IDs absent from the current catalog", async () => {
    installSuccessfulTransaction();

    const response = await PATCH(
      patchRequest({
        enabledTemplateIds: ["unknown"],
        defaultTemplateId: "unknown",
        expectedStoreVersion: 1,
        expectedCatalogRevision: revision,
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE stores store"),
      ),
    ).toBe(false);
  });

  it("returns 409 on store or catalog drift before updating metadata", async () => {
    installSuccessfulTransaction({ lockedStore: { ...store, version: 2 } });
    expect((await PATCH(patchRequest(), context)).status).toBe(409);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");

    transactionQuery.mockReset();
    installSuccessfulTransaction();
    const differentRevision = "0".repeat(64);
    expect(
      (
        await PATCH(
          patchRequest({
            enabledTemplateIds: ["standard"],
            defaultTemplateId: "standard",
            expectedStoreVersion: 1,
            expectedCatalogRevision: differentRevision,
          }),
          context,
        )
      ).status,
    ).toBe(409);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rolls back the metadata update when the audit insert fails", async () => {
    installSuccessfulTransaction({ auditFailure: true });

    const response = await PATCH(patchRequest(), context);

    expect(response.status).toBe(500);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(
      transactionQuery.mock.calls.some(([sql]) => sql === "COMMIT"),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
