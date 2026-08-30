import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connect,
  databaseQuery,
  prepareEndpoint,
  probeEndpoint,
  release,
  transactionQuery,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  databaseQuery: vi.fn(),
  prepareEndpoint: vi.fn(),
  probeEndpoint: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { createOrganization: vi.fn() } },
  authDatabase: { connect, query: databaseQuery },
}));
vi.mock("./federation-admin", () => ({
  isUuid: (value: unknown) =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  requireFederationAdmin: vi.fn(async () => ({
    admin: {
      rootTenantId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "223e4567-e89b-42d3-a456-426614174000",
    },
  })),
  validateFederationParent: vi.fn(async () => null),
}));
vi.mock("./federation-contract", () => ({
  validateFederationTokenEnv: (value: unknown) =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value) ? value : null,
}));
vi.mock("./platform-agent-tool", () => ({
  prepareSubplatformMcpEndpoint: prepareEndpoint,
  probeSubplatformMcpEndpoint: probeEndpoint,
  validateSubplatformMcpEndpointUrl: vi.fn(async () => true),
}));
vi.mock("./lib/runtime", () => ({ isProductionEnvironment: vi.fn(() => true) }));

import { POST } from "../app/api/platform/federation/bindings/activate/route";

const ids = {
  binding: "323e4567-e89b-42d3-a456-426614174000",
  tenant: "123e4567-e89b-42d3-a456-426614174000",
  domain: "423e4567-e89b-42d3-a456-426614174000",
  parent: "523e4567-e89b-42d3-a456-426614174000",
  organization: "623e4567-e89b-42d3-a456-426614174000",
  node: "723e4567-e89b-42d3-a456-426614174000",
};
const previousToken = process.env.REMOTE_STORE_TOKEN;

afterAll(() => {
  if (previousToken === undefined) delete process.env.REMOTE_STORE_TOKEN;
  else process.env.REMOTE_STORE_TOKEN = previousToken;
});

function request(): Request {
  return new Request("https://matx.test/api/platform/federation/bindings/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bindingId: ids.binding,
      tokenEnv: "REMOTE_STORE_TOKEN",
      membershipPolicy: "invite",
    }),
  });
}

describe("federation activation state transitions", () => {
  beforeEach(() => {
    process.env.REMOTE_STORE_TOKEN = "secret";
    connect.mockReset();
    databaseQuery.mockReset();
    prepareEndpoint.mockReset();
    probeEndpoint.mockReset();
    release.mockReset();
    transactionQuery.mockReset();
    connect.mockResolvedValue({ query: transactionQuery, release });
    prepareEndpoint.mockResolvedValue({ serverKey: "remote-store", url: "https://remote.example/mcp" });
  });

  it("does not let a stale successful probe overwrite a concurrent revocation", async () => {
    let rootQueryNumber = 0;
    databaseQuery.mockImplementation(async () => {
      rootQueryNumber += 1;
      if (rootQueryNumber === 1) {
        return {
          rowCount: 1,
          rows: [{
            id: ids.binding,
            tenantId: ids.tenant,
            domainId: ids.domain,
            parentOrganizationId: ids.parent,
            organizationId: ids.organization,
            registrationId: null,
            nodeId: ids.node,
            slug: "remote-store",
            displayName: "Remote store",
            endpoint: "https://remote.example/mcp",
            mcpServerKey: "remote-store",
            publicKey: "unused",
            manifest: { requiredScopes: ["retrieval:query"] },
            manifestDigest: "a".repeat(64),
            signature: "unused",
            status: "pending",
          }],
        };
      }
      if (rootQueryNumber === 2) {
        return {
          rowCount: 1,
          rows: [{
            id: ids.organization,
            slug: "remote-store",
            tenantId: ids.tenant,
            domainId: ids.domain,
            parentOrganizationId: ids.parent,
            rootPlatform: false,
          }],
        };
      }
      return { rowCount: 1, rows: [{ id: ids.organization }] };
    });

    let finishProbe: ((value: { ok: true; status: number }) => void) | undefined;
    probeEndpoint.mockReturnValue(new Promise((resolve) => {
      finishProbe = resolve;
    }));
    let lockedStatus = "pending";
    transactionQuery.mockImplementation(async (statement: string) => {
      if (statement === "BEGIN" || statement === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("FROM platform_federation_bindings") && statement.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ status: lockedStatus }] };
      }
      throw new Error(`stale activation reached unexpected SQL: ${statement}`);
    });

    const activation = POST(request());
    await vi.waitFor(() => expect(probeEndpoint).toHaveBeenCalledOnce());
    lockedStatus = "revoked";
    finishProbe?.({ ok: true, status: 200 });

    const response = await activation;

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "联邦绑定已在激活期间撤销" });
    expect(
      transactionQuery.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO subplatform_registrations"),
      ),
    ).toBe(false);
    expect(transactionQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
