import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyPlatformAdminInviteRole,
  connect,
  getSession,
  hasTrustedBrowserOrigin,
  release,
  transactionQuery,
} = vi.hoisted(() => ({
  applyPlatformAdminInviteRole: vi.fn(),
  connect: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  applyPlatformAdminInviteRole,
  auth: { api: { getSession } },
  authDatabase: { connect },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));

import { POST } from "../app/api/admin-invites/redeem/route";

const rootTenantId = "11111111-1111-4111-8111-111111111111";
const currentUserId = "22222222-2222-4222-8222-222222222222";
const priorClaimantId = "33333333-3333-4333-8333-333333333333";
const organizationId = "44444444-4444-4444-8444-444444444444";
const inviteId = "55555555-5555-4555-8555-555555555555";
const token = `mpa_${"a".repeat(64)}`;

function request(): Request {
  return new Request("https://matchplane.test/api/admin-invites/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "better-auth.session_token=session",
      origin: "https://matchplane.test",
    },
    body: JSON.stringify({ token }),
  });
}

describe("platform administrator invite redemption", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", rootTenantId);
    vi.clearAllMocks();
    hasTrustedBrowserOrigin.mockReturnValue(true);
    getSession.mockResolvedValue({
      user: {
        id: currentUserId,
        email: "admin@example.com",
        emailVerified: true,
      },
    });
    connect.mockResolvedValue({ query: transactionQuery, release });
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM platform_admin_invites")) {
        return {
          rowCount: 1,
          rows: [
            {
              inviteId,
              organizationId,
              role: "rootAdmin",
              targetEmail: "admin@example.com",
              tenantId: rootTenantId,
              rootPlatform: true,
              claimedBy: priorClaimantId,
              // This is deliberately expired: expiry must not transfer a token whose
              // first role application may have completed before the process crashed.
              claimExpiresAt: new Date(Date.now() - 60_000),
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("does not transfer an expired claim to a different account", async () => {
    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "管理员注册链接已绑定到其他账号",
    });
    expect(applyPlatformAdminInviteRole).not.toHaveBeenCalled();
    expect(transactionQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET claimed_by"),
      expect.anything(),
    );
    expect(transactionQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
