import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateFederationBinding: vi.fn(),
  createFederationInvite: vi.fn(async () => ({ inviteId: "invite", domainId: "domain", parentOrganizationId: "root", expiresAt: "2026-08-22T00:00:00.000Z", enrollmentToken: "mpf_token", enrollmentUrl: "https://mall.test/api/platform/federation/enroll" })),
  getFederationBindings: vi.fn(async () => []),
  probeFederationBinding: vi.fn(),
  revokeFederationBinding: vi.fn(),
}));

vi.mock("../api", () => api);

import { RemoteStoreOnboarding } from "./RemoteStoreOnboarding";

afterEach(() => vi.clearAllMocks());

describe("RemoteStoreOnboarding", () => {
  it("creates a controlled online-store enrollment instead of exposing a browser API-key field", async () => {
    const user = userEvent.setup();
    render(<RemoteStoreOnboarding domains={[{ id: "domain", slug: "market", name: "商城商品", status: "active", version: 1, created_at: "", updated_at: "" }]} onNotice={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "生成一次性连接链接" }));

    expect(api.createFederationInvite).toHaveBeenCalledWith({ domainId: "domain", expiresInHours: 168 });
    expect(await screen.findByText("一次性连接信息")).toBeInTheDocument();
    expect(screen.getByText("mpf_token")).toBeInTheDocument();
  });
});
