import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  readRoutes: vi.fn(),
  resolveEndpoint: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./lib/auth", () => ({ authDatabase: { query: mocks.query } }));
vi.mock("./platform-child-routes", () => ({
  readActiveDirectChildRoutes: mocks.readRoutes,
}));
vi.mock("./platform-agent-tool", () => ({
  resolveSubplatformMcpEndpoint: mocks.resolveEndpoint,
  invokeSubplatformMcpTool: mocks.invoke,
}));

import { runCatalogProjectionRelayOnce } from "./catalog-projection-relay";

const workerOptions = {
  workerId: "relay-test-worker",
  batchSize: 4,
  leaseSeconds: 45,
  maxAttempts: 8,
};

const jobRow = {
  id: "44444444-4444-4444-8444-444444444444",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  domain_id: "22222222-2222-4222-8222-222222222222",
  store_id: "33333333-3333-4333-8333-333333333333",
  offer_id: "55555555-5555-4555-8555-555555555555",
  canonical_version: "7",
  request_id: "66666666-6666-4666-8666-666666666666",
  attempts: 1,
  registration_id: "77777777-7777-4777-8777-777777777777",
  platform_path: "/auto",
  mcp_server_key: "auto",
};

function snapshot(version = "7") {
  return {
    tenant_id: jobRow.tenant_id,
    domain_id: jobRow.domain_id,
    store_id: jobRow.store_id,
    offer_id: jobRow.offer_id,
    canonical_version: version,
    external_key: "relay-offer",
    display_name: "Relay offer",
    product_template_id: "camera",
    attributes: { material: "paper" },
    terms: {},
    offer_status: "withdrawn",
    registration_id: jobRow.registration_id,
    platform_path: "/auto",
    mcp_server_key: "auto",
    store_status: "active",
    integration_kind: "package",
  };
}

function queueQueries(snapshotVersion = "7") {
  mocks.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [jobRow] })
    .mockResolvedValueOnce({ rows: [snapshot(snapshotVersion)] });
}

describe("catalog projection relay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates the child ACK before marking a job acknowledged", async () => {
    queueQueries();
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.readRoutes.mockResolvedValue([
      {
        path: "/auto",
        tenantId: jobRow.tenant_id,
        domainId: jobRow.domain_id,
        mcpServerKey: "auto",
        agentMcpTools: ["catalog.upsert"],
      },
    ]);
    mocks.resolveEndpoint.mockResolvedValue({
      url: "https://child.example/mcp",
      bearerToken: "server-secret",
      timeoutMs: 15_000,
    });
    mocks.invoke.mockImplementation(
      async (input: { arguments: Record<string, unknown> }) => {
        const projection = input.arguments as {
          protocol: string;
          request_id: string;
          canonical_version: number;
          projection_digest: string;
          scope: Record<string, unknown>;
          offer: {
            offer_id: string;
            product_template_id: string | null;
            status: string;
          };
        };
        return {
          ok: true,
          status: 200,
          payload: {
            result: {
              structuredContent: {
                protocol: projection.protocol,
                request_id: projection.request_id,
                canonical_version: projection.canonical_version,
                applied_version: projection.canonical_version,
                projection_digest: projection.projection_digest,
                scope: projection.scope,
                offer_id: projection.offer.offer_id,
                status: projection.offer.status,
                indexed: false,
                applied: true,
              },
            },
          },
        };
      },
    );

    await expect(runCatalogProjectionRelayOnce(workerOptions)).resolves.toEqual(
      {
        claimed: 1,
        acked: 1,
        superseded: 0,
        retried: 0,
        dead: 0,
      },
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    const projection = mocks.invoke.mock.calls[0]?.[0]?.arguments as {
      offer: { product_template_id: string | null };
    };
    expect(projection.offer.product_template_id).toBe("camera");
    expect(
      mocks.query.mock.calls.some(([statement]) =>
        String(statement).includes("offer.product_template_id"),
      ),
    ).toBe(true);
    expect(String(mocks.query.mock.calls.at(-1)?.[0])).toContain("status = $3");
  });

  it("supersedes a stale job without sending its old payload", async () => {
    queueQueries("8");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(runCatalogProjectionRelayOnce(workerOptions)).resolves.toEqual(
      {
        claimed: 1,
        acked: 0,
        superseded: 1,
        retried: 0,
        dead: 0,
      },
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("schedules a bounded retry when the child endpoint is unavailable", async () => {
    queueQueries();
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.readRoutes.mockResolvedValue([
      {
        path: "/auto",
        tenantId: jobRow.tenant_id,
        domainId: jobRow.domain_id,
        mcpServerKey: "auto",
        agentMcpTools: ["catalog.upsert"],
      },
    ]);
    mocks.resolveEndpoint.mockResolvedValue(null);

    await expect(runCatalogProjectionRelayOnce(workerOptions)).resolves.toEqual(
      {
        claimed: 1,
        acked: 0,
        superseded: 0,
        retried: 1,
        dead: 0,
      },
    );
    expect(String(mocks.query.mock.calls.at(-1)?.[0])).toContain(
      "status = 'retry'",
    );
  });
});
