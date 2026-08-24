import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  probePlatformRouter: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./platform-router", () => ({
  probePlatformRouter: mocks.probePlatformRouter,
}));

import { POST } from "../app/api/platform/ai/test/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: { id: "11111111-1111-4111-8111-111111111111", role: "rootAdmin" },
  });
});

describe("platform AI admin probe route", () => {
  it("returns a structured slow result as reachable instead of a 502", async () => {
    mocks.probePlatformRouter.mockResolvedValue({
      status: "slow",
      outcome: "slow",
      phase: "first_byte",
      model: "router-test",
      responseStatus: 200,
      latencyMs: 9_200,
      firstByteLatencyMs: 9_100,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
      message: "模型网关可达，但响应较慢。",
    });
    const request = new Request("http://localhost/api/platform/ai/test", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "slow",
      latencyMs: 9_200,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
    });
    expect(mocks.probePlatformRouter).toHaveBeenCalledWith(
      expect.objectContaining({ signal: request.signal, requestId: expect.any(String) }),
    );
  });
});
