import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createPlatformApiKey: vi.fn(),
  createPlatformAdminInvite: vi.fn(),
  createPlatformOidcClient: vi.fn(),
  activateFederationBinding: vi.fn(),
  createFederationInvite: vi.fn(),
  getFederationBindings: vi.fn(async () => []),
  getPlatformDomains: vi.fn(async () => []),
  getPlatformAccounts: vi.fn(async () => [
    { id: "owner", name: "Mall Owner", email: "owner@example.test", emailVerified: true, role: "rootSuperAdmin", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "customer", name: "Everyday Customer", email: "customer@example.test", emailVerified: true, role: "user", createdAt: "2026-08-02T00:00:00.000Z" },
  ]),
  getPlatformApiKeys: vi.fn(async () => []),
  getPlatformMembers: vi.fn(),
  getPlatformOidcClients: vi.fn(async () => []),
  invitePlatformMember: vi.fn(),
  removePlatformMember: vi.fn(),
  revokePlatformApiKey: vi.fn(),
  revokeFederationBinding: vi.fn(),
  probeFederationBinding: vi.fn(),
  updatePlatformMember: vi.fn(),
  updatePlatformApiKey: vi.fn(),
  updatePlatformOidcClient: vi.fn(),
}));

vi.mock("../api", () => api);

import { PlatformAccessPanel } from "./PlatformAccessPanel";

afterEach(() => vi.clearAllMocks());

describe("PlatformAccessPanel", () => {
  it("keeps ordinary registered users visible outside the operator team", async () => {
    const user = userEvent.setup();
    render(<PlatformAccessPanel organizations={[]} rootRole="rootSuperAdmin" onNotice={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "所有已注册用户" })).toBeInTheDocument();
    expect(screen.getByText(/customer@example\.test/)).toBeInTheDocument();
    expect(screen.getAllByText("普通用户")).toHaveLength(2);
    expect(screen.getByText("2 个账号")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "查找账号" }), "owner@");
    expect(screen.getByText(/owner@example\.test/)).toBeInTheDocument();
    expect(screen.queryByText(/customer@example\.test/)).not.toBeInTheDocument();
  });
});
