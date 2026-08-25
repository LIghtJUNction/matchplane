import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));

import { POST } from "../app/api/platform/ai/models/route";

function request(): Request {
  return new Request("http://localhost/api/platform/ai/models", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      endpoint: "https://provider.example/v1",
      protocol: "openai-compatible",
      apiKey: "must-not-be-used",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: { role: "rootSuperAdmin" },
  });
});

describe("platform AI model-list compatibility route", () => {
  it("returns a bounded 410 without contacting any provider", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");

    const response = await POST(request());

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "manual_model_configuration_required",
      error: "模型 ID 必须按供应商文档手动配置",
    });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });

  it("preserves trusted-origin, session, and rootSuperAdmin guards", async () => {
    mocks.hasTrustedBrowserOrigin.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();

    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);

    mocks.getSession.mockResolvedValueOnce({ user: { role: "rootAdmin" } });
    expect((await POST(request())).status).toBe(403);
  });
});
