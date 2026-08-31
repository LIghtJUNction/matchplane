import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MarketplaceApiError,
  type MarketplaceOffer,
  type StoreAcquisitionLink,
} from "../api";
import { resolveSubplatform } from "../subplatform";
import { StoreAcquisitionLinksPanel } from "./StoreAcquisitionLinksPanel";

const api = vi.hoisted(() => ({
  createStoreAcquisitionLink: vi.fn(),
  getMarketplaceOffers: vi.fn(),
  getStoreAcquisitionLinks: vi.fn(),
  updateStoreAcquisitionLinkStatus: vi.fn(),
}));
const getMarketplaceSession = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});
vi.mock("../lib/marketplace-session", () => ({ getMarketplaceSession }));

const store = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  domainId: "33333333-3333-4333-8333-333333333333",
  slug: "human-store",
  name: "Human store",
  displayName: "Human store",
  description: "Clear products",
  path: "/stores/human-store",
  integrationKind: "hosted" as const,
  visibility: "public" as const,
  state: "active" as const,
  role: "owner" as const,
  canManage: true,
};

const subplatform = {
  ...resolveSubplatform("/stores/human-store"),
  organizationId: "44444444-4444-4444-8444-444444444444",
  tenantId: store.tenantId,
  domainId: store.domainId,
};

const offer: MarketplaceOffer = {
  offer_id: "55555555-5555-4555-8555-555555555555",
  tenant_id: store.tenantId,
  domain_id: store.domainId,
  supply_party_id: "66666666-6666-4666-8666-666666666666",
  external_key: "offer-channel-course",
  display_name: "Channel course",
  attributes: {},
  terms: {},
  status: "active",
  version: 1,
  created_at: "2026-08-01T08:00:00.000Z",
  updated_at: "2026-08-01T08:00:00.000Z",
};

const activeLink: StoreAcquisitionLink = {
  id: "77777777-7777-4777-8777-777777777777",
  offerId: offer.offer_id,
  channelKey: "partner.editorial",
  sourceRef: "publisher-7",
  campaignRef: "autumn",
  status: "active",
  active: true,
  expiresAt: null,
  version: 2,
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
};

const expiredLink: StoreAcquisitionLink = {
  ...activeLink,
  id: "88888888-8888-4888-8888-888888888888",
  channelKey: "partner.expired",
  status: "disabled",
  active: false,
  expiresAt: "2020-01-01T00:00:00.000Z",
  version: 4,
};

function renderPanel(locale: "en" | "zh" = "en") {
  return render(
    <StoreAcquisitionLinksPanel
      locale={locale}
      store={store}
      subplatform={subplatform}
    />,
  );
}

async function waitForLoadedList() {
  await screen.findByRole("heading", { name: "Existing links" });
  await screen.findByRole("switch", { name: "Disable link partner.editorial" });
}

function createdLink(): StoreAcquisitionLink {
  return {
    ...activeLink,
    id: "99999999-9999-4999-8999-999999999999",
    channelKey: "partner.referral",
    sourceRef: "publisher-new",
    campaignRef: "launch-2026",
    version: 1,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  };
}

describe("StoreAcquisitionLinksPanel", () => {
  beforeEach(() => {
    api.createStoreAcquisitionLink.mockReset();
    api.getMarketplaceOffers.mockReset().mockResolvedValue([offer]);
    api.getStoreAcquisitionLinks.mockReset().mockResolvedValue([activeLink]);
    api.updateStoreAcquisitionLinkStatus.mockReset();
    getMarketplaceSession.mockReset().mockResolvedValue({
      accessToken: "seller-session-token",
      partyId: offer.supply_party_id,
      role: "seller",
      tenantId: store.tenantId,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists channel metadata, the associated product, and configured/effective state", async () => {
    renderPanel();
    await waitForLoadedList();

    expect(screen.getByText(/Source:\s*publisher-7/)).toBeInTheDocument();
    expect(screen.getByText(/Campaign:\s*autumn/)).toBeInTheDocument();
    expect(screen.getAllByText("Channel course").length).toBeGreaterThan(0);
    expect(screen.getByText("offer-channel-course")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByText("Effective")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText(/Aug 2, 2026/)).toBeInTheDocument();
    expect(api.getStoreAcquisitionLinks).toHaveBeenCalledWith(store.id);
  });

  it("surfaces an unavailable destination without pretending the configured link is live", async () => {
    api.getStoreAcquisitionLinks.mockResolvedValue([
      {
        ...activeLink,
        active: false,
        effectiveStatus: "unavailable",
        unavailableReason: "destination_unavailable",
      },
    ]);

    renderPanel();
    await waitForLoadedList();

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(/destination is unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Disable link partner.editorial" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("reveals the full path only after one successful POST, copies it, and removes every UI/storage/URL trace after close", async () => {
    const user = userEvent.setup();
    const rawPath = "/r/AAAAAAAAAAAAAAAAAAAAAA" as const;
    const initialUrl = window.location.href;
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    let resolveCreate:
      | ((value: { link: StoreAcquisitionLink; shortPath: typeof rawPath }) => void)
      | undefined;
    api.createStoreAcquisitionLink.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );

    renderPanel();
    await waitForLoadedList();
    await user.type(
      screen.getByLabelText("Canonical channel key"),
      "partner.referral",
    );
    await user.type(
      screen.getByLabelText("Source reference (optional)"),
      "publisher-new",
    );
    await user.type(
      screen.getByLabelText("Campaign reference (optional)"),
      "launch-2026",
    );

    const createButton = screen.getByRole("button", {
      name: "Create channel link",
    });
    await user.click(createButton);
    fireEvent.click(createButton);
    expect(api.createStoreAcquisitionLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(rawPath)).not.toBeInTheDocument();

    resolveCreate?.({ link: createdLink(), shortPath: rawPath });
    expect(await screen.findByText(rawPath)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy path" })).toHaveFocus();
    expect(api.createStoreAcquisitionLink).toHaveBeenCalledWith({
      storeId: store.id,
      offerId: offer.offer_id,
      channelKey: "partner.referral",
      sourceRef: "publisher-new",
      campaignRef: "launch-2026",
      expiresAt: null,
    });

    const listSection = screen
      .getByRole("heading", { name: "Existing links" })
      .closest("section");
    expect(listSection).not.toBeNull();
    expect(within(listSection as HTMLElement).queryByText(rawPath)).toBeNull();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(rawPath);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Close permanently" }),
    );
    expect(screen.queryByText(rawPath)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialUrl);
    await waitFor(() => expect(createButton).toHaveFocus());
  });

  it("keeps a failed copy recoverable without hiding the path", async () => {
    const user = userEvent.setup();
    const rawPath = "/r/BBBBBBBBBBBBBBBBBBBBBB" as const;
    api.createStoreAcquisitionLink.mockResolvedValue({
      link: createdLink(),
      shortPath: rawPath,
    });
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderPanel();
    await waitForLoadedList();
    await user.type(
      screen.getByLabelText("Canonical channel key"),
      "partner.referral",
    );
    await user.click(
      screen.getByRole("button", { name: "Create channel link" }),
    );
    await screen.findByText(rawPath);

    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(
      screen.getByText(/Clipboard access failed/),
    ).toBeInTheDocument();
    expect(screen.getByText(rawPath)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Try copy again" }));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("prevents expired disabled links from being restarted", async () => {
    api.getStoreAcquisitionLinks.mockResolvedValue([expiredLink]);
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Expired link partner.expired cannot be re-enabled",
    });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(api.updateStoreAcquisitionLinkStatus).not.toHaveBeenCalled();
  });

  it("saves an active/disabled switch against the current version", async () => {
    const user = userEvent.setup();
    const disabled = {
      ...activeLink,
      status: "disabled" as const,
      active: false,
      version: 3,
    };
    api.updateStoreAcquisitionLinkStatus.mockResolvedValue(disabled);

    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: "Disable link partner.editorial",
    });
    await user.click(toggle);

    expect(api.updateStoreAcquisitionLinkStatus).toHaveBeenCalledWith({
      storeId: store.id,
      linkId: activeLink.id,
      status: "disabled",
      expectedVersion: 2,
    });
    expect(
      await screen.findByRole("switch", {
        name: "Enable link partner.editorial",
      }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getAllByText("Disabled")).toHaveLength(2);
  });

  it("blocks a stale switch after a version conflict until refreshed", async () => {
    const user = userEvent.setup();
    const refreshed = {
      ...activeLink,
      status: "disabled" as const,
      active: false,
      version: 3,
    };
    api.getStoreAcquisitionLinks
      .mockResolvedValueOnce([activeLink])
      .mockResolvedValueOnce([refreshed]);
    api.updateStoreAcquisitionLinkStatus.mockRejectedValue(
      new MarketplaceApiError(409, "conflict"),
    );

    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: "Disable link partner.editorial",
    });
    await user.click(toggle);

    expect(
      await screen.findByText(/changed elsewhere/i),
    ).toBeInTheDocument();
    expect(toggle).toBeDisabled();
    expect(api.updateStoreAcquisitionLinkStatus).toHaveBeenCalledWith({
      storeId: store.id,
      linkId: activeLink.id,
      status: "disabled",
      expectedVersion: 2,
    });

    await user.click(screen.getByRole("button", { name: "Refresh links" }));
    const refreshedToggle = await screen.findByRole("switch", {
      name: "Enable link partner.editorial",
    });
    expect(refreshedToggle).toBeEnabled();
    expect(refreshedToggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
  });

  it("enforces canonical keys, bounded references, and future expiry before POST", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitForLoadedList();

    const channelInput = screen.getByLabelText("Canonical channel key");
    const campaignInput = screen.getByLabelText(
      "Campaign reference (optional)",
    );
    const expiryInput = screen.getByLabelText("Expiry (optional)");
    const createButton = screen.getByRole("button", {
      name: "Create channel link",
    });

    await user.type(channelInput, "Paid Social");
    await user.click(createButton);
    expect(screen.getByText(/canonical 1–64/)).toBeInTheDocument();
    expect(api.createStoreAcquisitionLink).not.toHaveBeenCalled();

    await user.clear(channelInput);
    await user.type(channelInput, "paid.social");
    fireEvent.change(campaignInput, { target: { value: "x".repeat(129) } });
    await user.click(createButton);
    expect(screen.getByText(/at most 128 safe characters/)).toBeInTheDocument();
    expect(api.createStoreAcquisitionLink).not.toHaveBeenCalled();

    fireEvent.change(campaignInput, { target: { value: "" } });
    fireEvent.change(expiryInput, { target: { value: "2020-01-01T00:00" } });
    await user.click(createButton);
    expect(screen.getByText(/expiry time in the future/)).toBeInTheDocument();
    expect(api.createStoreAcquisitionLink).not.toHaveBeenCalled();
  });

  it("keeps one refresh button DOM node and focus while suppressing duplicate refreshes", async () => {
    renderPanel();
    await waitForLoadedList();

    let resolveLinks: ((value: StoreAcquisitionLink[]) => void) | undefined;
    let resolveOffers: ((value: MarketplaceOffer[]) => void) | undefined;
    api.getStoreAcquisitionLinks.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLinks = resolve;
      }),
    );
    api.getMarketplaceOffers.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOffers = resolve;
      }),
    );

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    refreshButton.focus();
    fireEvent.click(refreshButton);
    fireEvent.click(refreshButton);

    expect(api.getStoreAcquisitionLinks).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(api.getMarketplaceOffers).toHaveBeenCalledTimes(2),
    );
    const busyButton = screen.getByRole("button", { name: "Refreshing…" });
    expect(busyButton).toBe(refreshButton);
    expect(document.activeElement).toBe(refreshButton);

    resolveLinks?.([activeLink]);
    resolveOffers?.([offer]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBe(
      refreshButton,
    );
  });

  it("offers localized error, retry, and empty states", async () => {
    const user = userEvent.setup();
    api.getStoreAcquisitionLinks
      .mockRejectedValueOnce(new Error("暂时离线"))
      .mockResolvedValueOnce([]);

    renderPanel("zh");
    expect(await screen.findByText("暂时离线")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有渠道链接")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建渠道链接" })).toBeEnabled();
  });
});
