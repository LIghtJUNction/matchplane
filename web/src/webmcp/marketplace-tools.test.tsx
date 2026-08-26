import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssetListing } from "../types";
import {
  createMarketplaceWebMcpTools,
  MARKETPLACE_WEBMCP_METADATA,
  MARKETPLACE_WEBMCP_SCHEMAS,
  type MarketplaceWebMcpContext,
  type WebMcpModelContext,
  type WebMcpTool,
} from "./marketplace-tools";
import { registerWebMcpTools } from "./register-tools";
import { useMarketplaceWebMcp } from "./useMarketplaceWebMcp";

const listing: AssetListing = {
  id: "visible-listing",
  title: "Visible listing",
  subtitle: "Public summary",
  storeName: "Visible store",
  price: "CNY 10",
  accent: "cactus",
  facts: [],
  likeTotal: "0",
  viewerLikeCount: 0,
  platformPath: "/visible-store",
};

function context(overrides: Partial<MarketplaceWebMcpContext> = {}) {
  return {
    visibleListings: [listing],
    visibleStorePaths: ["/visible-store"],
    describeNeed: vi.fn(),
    openStore: vi.fn(),
    openListing: vi.fn(),
    ...overrides,
  } satisfies MarketplaceWebMcpContext;
}

function byName(tools: readonly WebMcpTool[], name: string): WebMcpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "modelContext");
  Reflect.deleteProperty(navigator, "modelContext");
});

describe("marketplace WebMCP tool contract", () => {
  it("publishes the exact narrow names, descriptions, schemas, and annotations", () => {
    const tools = createMarketplaceWebMcpTools(() => context());

    expect(tools.map(({ name }) => name)).toEqual([
      MARKETPLACE_WEBMCP_METADATA.describeNeed.name,
      MARKETPLACE_WEBMCP_METADATA.openStore.name,
      MARKETPLACE_WEBMCP_METADATA.openListing.name,
    ]);
    expect(new Set(tools.map(({ name }) => name)).size).toBe(tools.length);
    expect(tools).toMatchObject([
      {
        ...MARKETPLACE_WEBMCP_METADATA.describeNeed,
        inputSchema: MARKETPLACE_WEBMCP_SCHEMAS.describeNeed,
        annotations: { readOnlyHint: false },
      },
      {
        ...MARKETPLACE_WEBMCP_METADATA.openStore,
        inputSchema: MARKETPLACE_WEBMCP_SCHEMAS.openStore,
        annotations: { readOnlyHint: false },
      },
      {
        ...MARKETPLACE_WEBMCP_METADATA.openListing,
        inputSchema: MARKETPLACE_WEBMCP_SCHEMAS.openListing,
        annotations: { readOnlyHint: false },
      },
    ]);

    const publicContract = JSON.stringify(
      tools.map(({ execute: _, ...tool }) => tool),
    );
    expect(publicContract).not.toMatch(
      /contact|consent|checkout|payment|admin|private|provider.token/i,
    );
    expect(publicContract.length).toBeLessThan(4_000);
  });

  it("bounds and strictly validates need input before reusing the visible draft callback", async () => {
    const snapshot = context();
    const tool = byName(
      createMarketplaceWebMcpTools(() => snapshot),
      MARKETPLACE_WEBMCP_METADATA.describeNeed.name,
    );

    await expect(
      tool.execute({ narrative: "  quiet headphones  " }),
    ).resolves.toEqual({
      ok: true,
      action: "need_drafted",
      character_count: 16,
      requires_user_submit: true,
    });
    expect(snapshot.describeNeed).toHaveBeenCalledWith("quiet headphones");

    for (const invalid of [
      {},
      [],
      { narrative: "" },
      { narrative: "x".repeat(2_001) },
      { narrative: "valid", hidden: true },
    ]) {
      await expect(tool.execute(invalid)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(snapshot.describeNeed).toHaveBeenCalledTimes(1);
  });

  it("matches JSON Schema Unicode scalar maxLength and result counts", async () => {
    const snapshot = context();
    const tool = byName(
      createMarketplaceWebMcpTools(() => snapshot),
      MARKETPLACE_WEBMCP_METADATA.describeNeed.name,
    );
    const emoji = "😀";
    const accepted = emoji.repeat(2_000);

    await expect(tool.execute({ narrative: accepted })).resolves.toEqual({
      ok: true,
      action: "need_drafted",
      character_count: 2_000,
      requires_user_submit: true,
    });
    expect(snapshot.describeNeed).toHaveBeenCalledWith(accepted);

    await expect(
      tool.execute({ narrative: emoji.repeat(2_001) }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(snapshot.describeNeed).toHaveBeenCalledTimes(1);
  });

  it("opens only stores and listings in the current visible API-derived set", async () => {
    let snapshot = context();
    const tools = createMarketplaceWebMcpTools(() => snapshot);
    const storeTool = byName(tools, MARKETPLACE_WEBMCP_METADATA.openStore.name);
    const listingTool = byName(
      tools,
      MARKETPLACE_WEBMCP_METADATA.openListing.name,
    );

    await expect(
      storeTool.execute({ platform_path: "/visible-store" }),
    ).resolves.toEqual({
      ok: true,
      action: "store_opened",
      platform_path: "/visible-store",
    });
    expect(snapshot.openStore).toHaveBeenCalledWith("/visible-store");

    await expect(
      listingTool.execute({ listing_id: "visible-listing" }),
    ).resolves.toEqual({
      ok: true,
      action: "listing_opened",
      listing_id: "visible-listing",
    });
    expect(snapshot.openListing).toHaveBeenCalledWith(listing);

    snapshot = context({ visibleListings: [], visibleStorePaths: [] });
    await expect(
      storeTool.execute({ platform_path: "/hidden-store" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_visible" } });
    await expect(
      listingTool.execute({ listing_id: "hidden-listing" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_visible" } });
    expect(snapshot.openStore).not.toHaveBeenCalled();
    expect(snapshot.openListing).not.toHaveBeenCalled();
  });
});

describe("WebMCP registration", () => {
  it("is a silent no-op without the document API and never relies on navigator legacy forms", () => {
    const legacyRegister = vi.fn();
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool: legacyRegister, provideContext: vi.fn() },
    });

    const cleanup = registerWebMcpTools(
      createMarketplaceWebMcpTools(() => context()),
      {
        document: {},
        secureContext: true,
        topLevel: true,
      },
    );

    expect(cleanup).not.toThrow();
    expect(legacyRegister).not.toHaveBeenCalled();
  });

  it("uses one AbortSignal, skips duplicate names, and aborts deterministic cleanup", () => {
    const registerTool = vi.fn(
      async (_tool: WebMcpTool, _options: { readonly signal: AbortSignal }) =>
        undefined,
    );
    const tools = createMarketplaceWebMcpTools(() => context());
    const cleanup = registerWebMcpTools([...tools, tools[0]], {
      document: { modelContext: { registerTool } },
      secureContext: true,
      topLevel: true,
    });

    expect(registerTool).toHaveBeenCalledTimes(3);
    const signals = registerTool.mock.calls.map((call) => call[1].signal);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0].aborted).toBe(false);
    cleanup();
    expect(signals[0].aborted).toBe(true);
  });

  it("contains permission rejection without throwing into the human UI", async () => {
    const registerTool = vi.fn(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );
    const cleanup = registerWebMcpTools(
      createMarketplaceWebMcpTools(() => context()),
      {
        document: { modelContext: { registerTool } },
        secureContext: true,
        topLevel: true,
      },
    );

    await Promise.resolve();
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(cleanup).not.toThrow();
  });
});

describe("useMarketplaceWebMcp", () => {
  it("registers page capabilities, reuses visible callbacks, and aborts on scope cleanup", async () => {
    vi.stubGlobal("isSecureContext", true);
    const registered: Array<{
      tool: WebMcpTool;
      signal: AbortSignal;
    }> = [];
    const modelContext: WebMcpModelContext = {
      registerTool: vi.fn(async (tool, options) => {
        registered.push({ tool, signal: options.signal });
      }),
    };
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: modelContext,
    });
    const openStore = vi.fn();
    const openListing = vi.fn();

    function Harness({ scopeKey }: { readonly scopeKey: string }) {
      const [draft, setDraft] = useState("");
      useMarketplaceWebMcp({
        enabled: true,
        scopeKey,
        visibleListings: [listing],
        visibleStorePaths: ["/visible-store"],
        describeNeed: setDraft,
        openStore,
        openListing,
      });
      return (
        <textarea aria-label="Visible need composer" value={draft} readOnly />
      );
    }

    const { rerender, unmount } = render(<Harness scopeKey="buyer:/" />);

    expect(registered).toHaveLength(3);
    const firstSignal = registered[0].signal;
    await act(async () => {
      await byName(
        registered.map(({ tool }) => tool),
        MARKETPLACE_WEBMCP_METADATA.describeNeed.name,
      ).execute({ narrative: "visible draft" });
    });
    expect(
      screen.getByRole("textbox", { name: "Visible need composer" }),
    ).toHaveValue("visible draft");

    rerender(<Harness scopeKey="buyer:/next" />);
    expect(firstSignal.aborted).toBe(true);
    expect(registered).toHaveLength(6);
    const secondSignal = registered[3].signal;
    unmount();
    expect(secondSignal.aborted).toBe(true);
  });
});
