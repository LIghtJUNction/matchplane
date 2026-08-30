import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createMarketplaceOffer, getMarketplaceSession } = vi.hoisted(() => ({
  createMarketplaceOffer: vi.fn(),
  getMarketplaceSession: vi.fn(),
}));

vi.mock("../api", () => ({
  createMarketplaceOffer,
  isLiveMarketplaceEnabled: () => true,
  submitSellerListing: vi.fn(),
}));
vi.mock("../lib/marketplace-session", () => ({ getMarketplaceSession }));

import { PluginHost } from "./PluginHost";

const session = {
  accessToken: "party-token",
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "22222222-2222-4222-8222-222222222222",
  partyId: "33333333-3333-4333-8333-333333333333",
};

async function submitFromPlugin(
  productTemplateId?: string,
): Promise<{ onNotice: ReturnType<typeof vi.fn> }> {
  const onNotice = vi.fn();
  render(
    <PluginHost
      subplatform={
        {
          slug: "store-a",
          path: "/store-a",
          label: "示例店铺",
          brandName: "示例店铺",
          tenantId: session.tenantId,
          domainId: session.domainId,
          marketplaceContract: "generic-v1",
          ui: {},
          pluginArtifact: {
            entry: "index.html",
            url: "/api/platform/plugin-assets/store-a/index.html",
            digest: "a".repeat(64),
          },
        } as never
      }
      role="seller"
      theme="light"
      locale="zh"
      onNotice={onNotice}
      fallback={null}
    />,
  );

  const frame = screen.getByTitle(
    "示例店铺 seller 工作台",
  ) as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("iframe window unavailable");
  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { protocol: "matchplane.plugin/v1", type: "plugin.ready" },
    }),
  );
  const context = postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .find((message) => message.type === "platform.context");
  const contextToken = (context?.payload as Record<string, unknown>)
    ?.contextToken;

  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        protocol: "matchplane.plugin/v1",
        type: "listing.submit",
        requestId: "submit-1",
        contextToken,
        payload: {
          externalKey: "inventory-1",
          displayName: "城市通勤方案",
          attributes: { category: "transport" },
          ...(productTemplateId === undefined ? {} : { productTemplateId }),
        },
      },
    }),
  );
  return { onNotice };
}

describe("PluginHost product-template offer submission", () => {
  afterEach(() => {
    createMarketplaceOffer.mockReset();
    getMarketplaceSession.mockReset();
  });

  it("passes the plugin-selected template separately from attributes", async () => {
    getMarketplaceSession.mockResolvedValue(session);
    createMarketplaceOffer.mockResolvedValue({});

    await submitFromPlugin("book.v2");
    await waitFor(() => expect(createMarketplaceOffer).toHaveBeenCalledOnce());

    expect(createMarketplaceOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        productTemplateId: "book.v2",
        attributes: { category: "transport" },
      }),
    );
    expect(
      createMarketplaceOffer.mock.calls[0]?.[0].attributes,
    ).not.toHaveProperty("productTemplateId");
  });

  it("passes null for a legacy plugin instead of selecting the first template", async () => {
    getMarketplaceSession.mockResolvedValue(session);
    createMarketplaceOffer.mockResolvedValue({});

    await submitFromPlugin();
    await waitFor(() => expect(createMarketplaceOffer).toHaveBeenCalledOnce());

    expect(createMarketplaceOffer).toHaveBeenCalledWith(
      expect.objectContaining({ productTemplateId: null }),
    );
  });

  it("rejects a non-canonical uppercase template ID before creating an offer", async () => {
    const { onNotice } = await submitFromPlugin("Book");

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("商品模板编号格式无效"),
    );
    expect(getMarketplaceSession).not.toHaveBeenCalled();
    expect(createMarketplaceOffer).not.toHaveBeenCalled();
  });
});
