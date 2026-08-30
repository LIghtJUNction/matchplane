import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connect, hasTrustedBrowserOrigin, release, transactionQuery } =
  vi.hoisted(() => ({
    connect: vi.fn(),
    hasTrustedBrowserOrigin: vi.fn(),
    release: vi.fn(),
    transactionQuery: vi.fn(),
  }));

vi.mock("./lib/auth", () => ({
  authDatabase: { connect },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/runtime", () => ({
  isProductionEnvironment: vi.fn(() => false),
}));

import { POST } from "../app/api/super-admin-bootstrap/claim/route";
import { SUPER_ADMIN_BOOTSTRAP_COOKIE } from "./lib/super-admin-bootstrap";

const tenantId = "11111111-1111-4111-8111-111111111111";
const token = `mpsa_${"a".repeat(64)}`;

function request(): Request {
  return new Request(
    "https://matchplane.test/api/super-admin-bootstrap/claim",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://matchplane.test",
      },
      body: JSON.stringify({ token, email: "owner@example.com" }),
    },
  );
}

describe("super administrator bootstrap reservation", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", tenantId);
    vi.clearAllMocks();
    hasTrustedBrowserOrigin.mockReturnValue(true);
    connect.mockResolvedValue({ query: transactionQuery, release });
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)::text"))
        return { rowCount: 1, rows: [{ count: "0" }] };
      if (sql.includes("FROM root_superadmin_invites")) {
        return {
          rowCount: 1,
          rows: [{ target_email: null, registration_email: null }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("binds the original bearer to the registering browser's auth path", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SUPER_ADMIN_BOOTSTRAP_COOKIE}=${token}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Max-Age=600/i);
    expect(cookie).toMatch(/Path=\/api\/auth/i);
    expect(cookie).not.toMatch(/; Secure/i);
    expect(release).toHaveBeenCalledOnce();
  });
});
