import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/auth-client", () => ({
  authClient: {
    getSession: vi.fn(async () => ({ data: null, error: null })),
    signOut: vi.fn(async () => ({ data: null, error: null })),
  },
  authFetchOptions: (subplatform: string) => ({
    headers: { "x-matchplane-subplatform": subplatform },
    credentials: "include",
  }),
}));

import { App } from "./App";

const OFFER_A = "00000000-0000-7000-8000-000000000101";
const OFFER_B = "00000000-0000-7000-8000-000000000102";
const HIDDEN_OFFER = "00000000-0000-7000-8000-000000000103";
const TENANT_ID = "00000000-0000-7000-8000-000000000201";
const DOMAIN_ID = "00000000-0000-7000-8000-000000000301";

type Recommendation = {
  listing_id: string;
  offer_id: string;
  display_name: string;
  platform_path: string;
  tenant_id: string;
  domain_id: string;
  attributes: { description: string };
  terms: { amount_minor: string; currency: string; currency_scale: number };
  store_name: string;
};

let manifestStatus: "active" | "closed";
let recommendations: Recommendation[];
let requestedUrls: string[];

function recommendation(
  offerId: string,
  title: string,
  platformPath = "/store-a",
): Recommendation {
  return {
    listing_id: offerId,
    offer_id: offerId,
    display_name: title,
    platform_path: platformPath,
    tenant_id: TENANT_ID,
    domain_id: DOMAIN_ID,
    attributes: { description: `${title} description` },
    terms: {
      amount_minor: "120000",
      currency: "CNY",
      currency_scale: 2,
    },
    store_name: platformPath === "/store-a" ? "Store A" : "Store B",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function expectOnlyPublicCatalogRequests(): void {
  expect(requestedUrls.length).toBeGreaterThan(0);
  expect(
    requestedUrls.filter(
      (url) =>
        url !== "/api/mall/settings" &&
        url !== "/api/mall/search" &&
        url !== "/api/stores" &&
        !url.startsWith("/api/mall/search?storePath=") &&
        !url.startsWith("/api/platform/manifest?path=") &&
        !url.startsWith("/api/platform/site-settings?platformPath="),
    ),
  ).toEqual([]);
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.dataset.palette = "ink";
  document.documentElement.lang = "zh-CN";

  manifestStatus = "active";
  recommendations = [recommendation(OFFER_A, "Alpha camera")];
  requestedUrls = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    requestedUrls.push(url);

    if (url === "/api/mall/settings") {
      return jsonResponse({ mall: { name: "MatchPlane" } });
    }
    if (url.startsWith("/api/platform/manifest?path=")) {
      return jsonResponse({
        displayName: "Store A",
        description: "Public storefront",
        status: manifestStatus,
        tenantId: TENANT_ID,
        domainId: DOMAIN_ID,
      });
    }
    if (
      url === "/api/mall/search" ||
      url.startsWith("/api/mall/search?storePath=")
    ) {
      return jsonResponse({
        requestId: "00000000-0000-7000-8000-000000000401",
        stores: [],
        recommendations,
        routing: {
          source: "policy_fallback",
          degraded: false,
          rationale: "test catalog",
        },
      });
    }
    if (url === "/api/stores") {
      return jsonResponse({ stores: [] });
    }
    return jsonResponse({ error: "unexpected private request" }, 503);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canonical offer deep links", () => {
  it.each([
    ["root marketplace", "/"],
    ["storefront", "/store-a"],
  ])("auto-opens a visible offer on the %s", async (_label, path) => {
    window.history.replaceState(
      null,
      "",
      `${path}?offer=${OFFER_A}&campaign=summer#facts`,
    );

    render(<App initialPath={path} />);

    expect(
      await screen.findByRole("dialog", { name: "Alpha camera" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "关闭供给详情" }),
      ).toHaveFocus(),
    );
    expect(new URLSearchParams(window.location.search).getAll("offer")).toEqual(
      [OFFER_A],
    );
    expectOnlyPublicCatalogRequests();
  });

  it("removes only offer on close, preserves query/hash, and restores main focus", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      null,
      "",
      `/store-a?campaign=summer&offer=${OFFER_A}&theme_hint=dark#facts`,
    );

    render(<App initialPath="/store-a" />);

    await screen.findByRole("dialog", { name: "Alpha camera" });
    await user.click(screen.getByRole("button", { name: "关闭供给详情" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const searchParams = new URLSearchParams(window.location.search);
    expect(searchParams.has("offer")).toBe(false);
    expect(searchParams.get("campaign")).toBe("summer");
    expect(searchParams.get("theme_hint")).toBe("dark");
    expect(window.location.hash).toBe("#facts");
    await waitFor(() =>
      expect(document.getElementById("main-content")).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
  });

  it.each([
    {
      label: "invalid UUID",
      search: "offer=not-a-uuid",
      status: "active" as const,
      items: [recommendation(OFFER_A, "Alpha camera")],
    },
    {
      label: "duplicate offer keys",
      search: `offer=${OFFER_A}&offer=${OFFER_A}`,
      status: "active" as const,
      items: [recommendation(OFFER_A, "Alpha camera")],
    },
    {
      label: "unknown or hidden offer",
      search: `offer=${HIDDEN_OFFER}`,
      status: "active" as const,
      items: [recommendation(OFFER_A, "Alpha camera")],
    },
    {
      label: "offer from another store",
      search: `offer=${OFFER_B}`,
      status: "active" as const,
      items: [recommendation(OFFER_B, "Beta camera", "/store-b")],
    },
    {
      label: "inactive offer omitted from the public catalog",
      search: `offer=${OFFER_A}`,
      status: "active" as const,
      items: [],
    },
    {
      label: "offer on a closed storefront",
      search: `offer=${OFFER_A}`,
      status: "closed" as const,
      items: [recommendation(OFFER_A, "Alpha camera")],
    },
  ])("fails closed for $label", async ({ search, status, items }) => {
    manifestStatus = status;
    recommendations = items;
    window.history.replaceState(null, "", `/store-a?keep=yes&${search}#anchor`);

    render(<App initialPath="/store-a" />);

    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).has("offer")).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
    expect(window.location.hash).toBe("#anchor");
    expectOnlyPublicCatalogRequests();
  });

  it("tracks same-page offer changes and browser back/forward without a private lookup", async () => {
    recommendations = [
      recommendation(OFFER_A, "Alpha camera"),
      recommendation(OFFER_B, "Beta camera"),
    ];
    window.history.replaceState(
      null,
      "",
      `/store-a?offer=${OFFER_A}&keep=yes#facts`,
    );

    render(<App initialPath="/store-a" />);
    await screen.findByRole("dialog", { name: "Alpha camera" });

    act(() => {
      window.history.pushState(
        null,
        "",
        `/store-a?offer=${OFFER_B}&keep=yes#facts`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByRole("dialog", { name: "Beta camera" });

    act(() => window.history.back());
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("offer")).toBe(
        OFFER_A,
      ),
    );
    await screen.findByRole("dialog", { name: "Alpha camera" });

    act(() => window.history.forward());
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("offer")).toBe(
        OFFER_B,
      ),
    );
    await screen.findByRole("dialog", { name: "Beta camera" });

    expect(new URLSearchParams(window.location.search).get("keep")).toBe("yes");
    expect(window.location.hash).toBe("#facts");
    expectOnlyPublicCatalogRequests();
  });
});
