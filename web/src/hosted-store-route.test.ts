import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connect,
  createOrganization,
  getSession,
  hasTrustedBrowserOrigin,
  release,
  rootQuery,
  transactionQuery,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  createOrganization: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  release: vi.fn(),
  rootQuery: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { createOrganization, getSession } },
  authDatabase: { connect, query: rootQuery },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./store-directory", () => ({ readPublicStores: vi.fn() }));

import { POST } from "../app/api/stores/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const rootOrganizationId = "33333333-3333-4333-8333-333333333333";
const storeOrganizationId = "44444444-4444-4444-8444-444444444444";

function request(body: unknown): Request {
  return new Request("https://matchplane.test/api/stores", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://matchplane.test",
    },
    body: JSON.stringify(body),
  });
}

describe("hosted store creation", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", tenantId);
    connect.mockReset();
    createOrganization.mockReset();
    getSession.mockReset();
    hasTrustedBrowserOrigin.mockReset();
    release.mockReset();
    rootQuery.mockReset();
    transactionQuery.mockReset();

    hasTrustedBrowserOrigin.mockReturnValue(true);
    getSession.mockResolvedValue({
      user: { id: userId, emailVerified: true },
    });
    rootQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "organization"'))
        return { rowCount: 1, rows: [{ id: rootOrganizationId }] };
      if (sql.includes("AS owned"))
        return { rowCount: 1, rows: [{ owned: 0, recent: 0 }] };
      return { rowCount: 1, rows: [] };
    });
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)::int AS count"))
        return { rowCount: 1, rows: [{ count: 0 }] };
      return { rowCount: 1, rows: [] };
    });
    connect.mockResolvedValue({ query: transactionQuery, release });
    createOrganization.mockImplementation(async ({ body }) => ({
      id: storeOrganizationId,
      name: body.name,
      slug: body.slug,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("assigns an opaque path server-side and ignores a client path", async () => {
    const response = await POST(
      request({
        name: "山里杂货铺",
        description: "手作与山货",
        slug: "user-picked-path",
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      store: {
        slug: string;
        path: string;
        membershipRole: string;
      };
    };
    expect(body.store.slug).toMatch(/^store-[0-9a-f]{12}$/);
    expect(body.store.slug).not.toBe("user-picked-path");
    expect(body.store.path).toBe(`/${body.store.slug}`);
    expect(body.store.membershipRole).toBe("owner");

    const organizationInput = createOrganization.mock.calls[0]?.[0];
    expect(organizationInput.body.slug).toBe(body.store.slug);
    const storeInsert = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO stores"),
    );
    expect(storeInsert?.[1]?.[4]).toBe(body.store.slug);
    expect(release).toHaveBeenCalledOnce();
  });
});
