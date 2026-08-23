import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  establishMarketplaceSession: vi.fn(),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  readPartySession: vi.fn(() => null),
}));
const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api", () => api);
vi.mock("./auth-client", () => ({
  authClient: { getSession: auth.getSession },
  authFetchOptions: vi.fn(() => ({})),
}));

import { getMarketplaceSession } from "./marketplace-session";

beforeEach(() => {
  api.establishMarketplaceSession.mockReset();
  api.isLiveMarketplaceEnabled.mockReturnValue(true);
  api.readPartySession.mockReset();
  api.readPartySession.mockReturnValue(null);
  auth.getSession.mockReset();
  auth.getSession.mockResolvedValue({
    data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
    error: null,
  });
});

describe("marketplace session exchange", () => {
  it("deduplicates concurrent buyer and seller exchange for a store operator", async () => {
    let resolveSession:
      | ((value: {
          tenantId: string;
          partyId: string;
          authUserId: string;
          role: "both";
          accessToken: string;
          accessTokenExpiresAt: string;
          platformPath: string;
        }) => void)
      | undefined;
    api.establishMarketplaceSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const input = {
      subplatform: "store-test",
      platformPath: "/store-test",
      tenantId: "22222222-2222-4222-8222-222222222222",
      domainId: "33333333-3333-4333-8333-333333333333",
    };

    const buyer = getMarketplaceSession({ ...input, role: "buyer" });
    const seller = getMarketplaceSession({ ...input, role: "seller" });
    await vi.waitFor(() =>
      expect(api.establishMarketplaceSession).toHaveBeenCalledOnce(),
    );
    resolveSession?.({
      tenantId: input.tenantId,
      partyId: "44444444-4444-4444-8444-444444444444",
      authUserId: "11111111-1111-4111-8111-111111111111",
      role: "both",
      accessToken: "shared",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      platformPath: input.platformPath,
    });

    await expect(buyer).resolves.toMatchObject({
      role: "both",
      accessToken: "shared",
    });
    await expect(seller).resolves.toMatchObject({
      role: "both",
      accessToken: "shared",
    });
    expect(api.establishMarketplaceSession).toHaveBeenCalledOnce();
  });

  it("lets the root exchange infer its tenant server-side", async () => {
    api.establishMarketplaceSession.mockResolvedValue({
      tenantId: "22222222-2222-4222-8222-222222222222",
      partyId: "44444444-4444-4444-8444-444444444444",
      authUserId: "11111111-1111-4111-8111-111111111111",
      role: "buyer",
      accessToken: "root",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      platformPath: "/",
    });

    await expect(
      getMarketplaceSession({
        subplatform: "root",
        platformPath: "/",
        role: "buyer",
      }),
    ).resolves.toMatchObject({ accessToken: "root" });
    expect(api.establishMarketplaceSession).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined, subplatform: "root" }),
    );
  });
});
