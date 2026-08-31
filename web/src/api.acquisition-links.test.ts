import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStoreAcquisitionLink,
  getStoreAcquisitionLinks,
  MarketplaceApiError,
  updateStoreAcquisitionLinkStatus,
  type StoreAcquisitionLink,
} from "./api";

const storeId = "11111111-1111-4111-8111-111111111111";
const link: StoreAcquisitionLink = {
  id: "22222222-2222-4222-8222-222222222222",
  offerId: "33333333-3333-4333-8333-333333333333",
  channelKey: "partner.editorial",
  sourceRef: "publisher-7",
  campaignRef: null,
  status: "active",
  active: true,
  expiresAt: null,
  version: 1,
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("store acquisition link API helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("GET reads token-free metadata with explicit no-store credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ links: [link] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getStoreAcquisitionLinks(storeId)).resolves.toEqual([link]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/stores/${storeId}/acquisition-links`,
      {
        cache: "no-store",
        credentials: "include",
        headers: { accept: "application/json" },
      },
    );
  });

  it("POST returns the validated one-time path without writing storage or URL state", async () => {
    const shortPath = "/r/AAAAAAAAAAAAAAAAAAAAAA" as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ link, shortPath }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const initialUrl = window.location.href;

    await expect(
      createStoreAcquisitionLink({
        storeId,
        offerId: link.offerId,
        channelKey: link.channelKey,
        sourceRef: link.sourceRef,
      }),
    ).resolves.toEqual({ link, shortPath });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      offerId: link.offerId,
      channelKey: link.channelKey,
      sourceRef: "publisher-7",
      campaignRef: null,
      expiresAt: null,
    });
    expect(storageWrite).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialUrl);
  });

  it("PATCH sends the configured status and exact expected version", async () => {
    const updated = {
      ...link,
      status: "disabled" as const,
      active: false,
      version: 2,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ link: updated }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateStoreAcquisitionLinkStatus({
        storeId,
        linkId: link.id,
        status: "disabled",
        expectedVersion: 1,
      }),
    ).resolves.toEqual(updated);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      linkId: link.id,
      status: "disabled",
      expectedVersion: 1,
    });
  });

  it("rejects malformed success bodies and preserves HTTP conflicts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ link, shortPath: "/r/raw" }, 201))
      .mockResolvedValueOnce(jsonResponse({ error: "version conflict" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createStoreAcquisitionLink({
        storeId,
        offerId: link.offerId,
        channelKey: link.channelKey,
      }),
    ).rejects.toBeInstanceOf(MarketplaceApiError);
    await expect(
      updateStoreAcquisitionLinkStatus({
        storeId,
        linkId: link.id,
        status: "disabled",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409, message: "version conflict" });
  });
});
