import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMarketplaceIntroductions: vi.fn(async (): Promise<unknown[]> => []),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  retrieveMarketplaceContact: vi.fn(),
}));

vi.mock("../api", () => api);
vi.mock("../lib/marketplace-session", () => ({
  getMarketplaceSession: vi.fn(async () => ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    partyId: "22222222-2222-4222-8222-222222222222",
    role: "buyer",
    accessToken: "test-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })),
}));

import { markStoreContactRequested } from "../lib/contact-requests";
import type { SubplatformConfig } from "../subplatform";
import { StoreContactRequestsPanel } from "./StoreContactRequestsPanel";

const subplatform = {
  slug: "my-store",
  path: "/my-store",
  label: "我的店铺",
  brandName: "我的店铺",
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "33333333-3333-4333-8333-333333333333",
  marketplaceContract: "generic-v1",
  ui: {},
} as unknown as SubplatformConfig;

function introduction(overrides: Record<string, unknown> = {}) {
  return {
    introduction_id: "44444444-4444-4444-8444-444444444444",
    tenant_id: subplatform.tenantId,
    intent_id: "55555555-5555-4555-8555-555555555555",
    offer_id: "66666666-6666-4666-8666-666666666666",
    demand_party_id: "22222222-2222-4222-8222-222222222222",
    supply_party_id: "77777777-7777-4777-8777-777777777777",
    score: 0.9,
    reasons: [],
    status: "contact_requested",
    supply_contact_consent_at: null,
    contact_released_at: null,
    idempotency_key: "key",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    version: 1,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.isLiveMarketplaceEnabled.mockReturnValue(true);
  api.getMarketplaceIntroductions.mockResolvedValue([]);
});

describe("StoreContactRequestsPanel", () => {
  it("renders nothing when this browser never sent a contact request", async () => {
    const { container } = render(
      <StoreContactRequestsPanel subplatform={subplatform} locale="zh" />,
    );
    await waitFor(() =>
      expect(api.getMarketplaceIntroductions).not.toHaveBeenCalled(),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a pending request as waiting for store approval", async () => {
    markStoreContactRequested(subplatform.path);
    api.getMarketplaceIntroductions.mockResolvedValue([introduction()]);
    render(<StoreContactRequestsPanel subplatform={subplatform} locale="zh" />);

    expect(
      await screen.findByRole("heading", { name: "联系申请" }),
    ).toBeInTheDocument();
    expect(screen.getByText("等待店员同意")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "查看对方联系方式" }),
    ).not.toBeInTheDocument();
  });

  it("reveals the verified store contact after staff approve", async () => {
    markStoreContactRequested(subplatform.path);
    api.getMarketplaceIntroductions.mockResolvedValue([
      introduction({
        status: "contact_released",
        supply_contact_consent_at: "2026-08-25T01:00:00Z",
      }),
    ]);
    api.retrieveMarketplaceContact.mockResolvedValue({
      counterpart: {
        party_id: "77777777-7777-4777-8777-777777777777",
        display_name: "店员小李",
        contact: { email: "shop@example.com", phone: "+86 130 0000 0000" },
      },
      introduction: introduction({
        status: "contact_released",
        supply_contact_consent_at: "2026-08-25T01:00:00Z",
        contact_released_at: "2026-08-25T02:00:00Z",
      }),
    });
    const user = userEvent.setup();
    render(<StoreContactRequestsPanel subplatform={subplatform} locale="zh" />);

    await user.click(
      await screen.findByRole("button", { name: "查看对方联系方式" }),
    );

    expect(await screen.findByText("店员小李")).toBeInTheDocument();
    expect(screen.getByText(/shop@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/\+86 130 0000 0000/)).toBeInTheDocument();
    expect(screen.getByText("已可联系")).toBeInTheDocument();
    expect(api.retrieveMarketplaceContact).toHaveBeenCalledWith(
      expect.objectContaining({
        domainId: subplatform.domainId,
        introductionId: "44444444-4444-4444-8444-444444444444",
      }),
    );
  });

  it("only lists requests where the signed-in buyer is the demand party", async () => {
    markStoreContactRequested(subplatform.path);
    api.getMarketplaceIntroductions.mockResolvedValue([
      introduction({
        introduction_id: "88888888-8888-4888-8888-888888888888",
        demand_party_id: "99999999-9999-4999-8999-999999999999",
      }),
    ]);
    const { container } = render(
      <StoreContactRequestsPanel subplatform={subplatform} locale="zh" />,
    );
    await waitFor(() =>
      expect(api.getMarketplaceIntroductions).toHaveBeenCalled(),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
