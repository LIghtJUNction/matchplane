import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, hasTrustedBrowserOrigin } = vi.hoisted(() => ({
  query: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
}));

vi.mock("./lib/auth", () => ({ authDatabase: { query } }));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));

import { POST } from "../app/api/registration/identity/route";

function request(body: unknown): Request {
  return new Request("https://matx.test/api/registration/identity", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://matx.test" },
    body: JSON.stringify(body),
  });
}

describe("registration identity lookup", () => {
  beforeEach(() => {
    query.mockReset();
    hasTrustedBrowserOrigin.mockReset();
    hasTrustedBrowserOrigin.mockReturnValue(true);
  });

  it("keeps a new email on the normal account-creation path", async () => {
    query.mockResolvedValue({ rows: [] });

    const response = await POST(request({ email: "new@example.test" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "new" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM "user"'), ["new@example.test"]);
  });

  it("routes a verified identity through password proof instead of a duplicate account", async () => {
    query.mockResolvedValue({ rows: [{ emailVerified: true }] });

    const response = await POST(request({ email: "Existing@Example.test" }));

    await expect(response.json()).resolves.toEqual({ state: "existing" });
    expect(query.mock.calls[0]?.[1]).toEqual(["existing@example.test"]);
  });

  it("resumes an unfinished registration with verification rather than creating another user", async () => {
    query.mockResolvedValue({ rows: [{ emailVerified: false }] });

    const response = await POST(request({ email: "pending@example.test" }));

    await expect(response.json()).resolves.toEqual({ state: "pending_verification" });
  });
});
