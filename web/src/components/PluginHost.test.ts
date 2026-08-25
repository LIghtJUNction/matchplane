import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AssetListing } from "../types";
import { PluginHost, pluginCapabilitiesForRole } from "./PluginHost";

describe("PluginHost role capabilities", () => {
  it("never grants listing submission to a buyer workspace", () => {
    expect(pluginCapabilitiesForRole("buyer", false)).toEqual([
      "chat.open",
      "match.results",
      "listing.open",
      "auth.open",
      "demand.open",
      "listing.like",
    ]);
    expect(pluginCapabilitiesForRole("buyer", true)).toEqual([
      "match.results",
      "listing.open",
      "auth.open",
      "demand.open",
      "listing.like",
    ]);
  });

  it("grants listing submission only to the seller workspace", () => {
    expect(pluginCapabilitiesForRole("seller", false)).toContain(
      "listing.submit",
    );
    expect(pluginCapabilitiesForRole("platform", false)).not.toContain(
      "listing.submit",
    );
  });

  it("keeps auth and likes in the host while exposing only bounded context", async () => {
    const listing: AssetListing = {
      id: "listing-1",
      offerId: "offer-1",
      title: "二手车",
      subtitle: "认证车商",
      price: "¥100,000",
      accent: "cactus",
      facts: [],
    };
    const onLikeListing = vi.fn(async () => undefined);
    render(
      createElement(PluginHost, {
        subplatform: {
          slug: "store-a",
          path: "/store-a",
          label: "二手车",
          brandName: "二手车",
          ui: {},
          pluginArtifact: {
            entry: "index.html",
            url: "/api/platform/plugin-assets/store-a/index.html",
            digest: "a".repeat(64),
          },
        } as never,
        role: "buyer",
        theme: "light",
        locale: "zh",
        authStatus: "authenticated",
        listings: [listing],
        onLikeListing,
        onNotice: vi.fn(),
        fallback: null,
      }),
    );

    const frame = screen.getByTitle("二手车 buyer 工作台") as HTMLIFrameElement;
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
    expect(context).toBeDefined();
    expect(context).not.toHaveProperty("accessToken");
    expect(context).not.toHaveProperty("user");
    expect(context?.payload).toEqual(
      expect.objectContaining({ auth: { status: "authenticated" } }),
    );

    const contextPayload = context?.payload as Record<string, unknown>;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: {
          protocol: "matchplane.plugin/v1",
          type: "listing.like",
          requestId: "like-1",
          contextToken: contextPayload.contextToken,
          payload: { listingId: "offer-1" },
        },
      }),
    );

    await waitFor(() => expect(onLikeListing).toHaveBeenCalledWith(listing));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "listing.like.result",
        requestId: "like-1",
        ok: true,
      }),
      "*",
    );
  });
});
