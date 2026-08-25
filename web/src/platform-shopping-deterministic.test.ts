import { afterEach, describe, expect, it, vi } from "vitest";

const searchPublicStoreOffers = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>[]> => []),
);

vi.mock("ai", () => ({
  generateText: vi.fn(),
  pruneMessages: ({ messages }: { messages: unknown[] }) => messages,
  stepCountIs: (count: number) => ({ count }),
  tool: <T>(definition: T) => definition,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(),
}));

vi.mock("./lib/platform-router-config", () => ({
  readManagedPlatformRouterConfig: () => null,
}));

vi.mock("./storefront-search", () => ({
  searchPublicStoreOffers,
  searchPublicStoreOfferPage: vi.fn(async () => ({
    items: [],
    total: 0,
    offset: 0,
    limit: 6,
    hasMore: false,
  })),
}));

import { answerPlatformShoppingQuestion } from "./platform-router";
import type { PublicStore } from "./store-directory";

afterEach(() => {
  searchPublicStoreOffers.mockClear();
});

function demoStore(publicFields: string[]): PublicStore {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "demo",
    path: "/demo",
    displayName: "星辰二手车行",
    description: "",
    integrationKind: "hosted",
    capabilities: [],
    agentStages: [],
    agentSkills: [],
    publicFields,
    tenantId: "22222222-2222-4222-8222-222222222222",
    domainId: "33333333-3333-4333-8333-333333333333",
  };
}

describe("deterministic shopping fallback without AI gateway", () => {
  it("asks for budget when purchase intent is vague", async () => {
    const reply = await answerPlatformShoppingQuestion({
      question: "我想买辆车",
      messages: [{ role: "user", content: "我想买辆车" }],
      stores: [demoStore([])],
    });
    expect(reply.model).toBeNull();
    expect(reply.toolCalls).toEqual(["ask_user"]);
    expect(reply.uiActions[0]).toMatchObject({ type: "choice" });
    expect(searchPublicStoreOffers).not.toHaveBeenCalled();
  });

  it("searches and shows products when budget is known", async () => {
    searchPublicStoreOffers.mockResolvedValueOnce([
      {
        offer_id: "o1",
        display_name: "本田 CR-V",
        attributes: { category: "SUV" },
        terms: {
          pricing_mode: "fixed",
          amount_minor: "13280000",
          currency: "CNY",
          currency_scale: 2,
        },
        platform_path: "/demo-car-shop",
        store_name: "星辰二手车行",
        match_score: 0.9,
        match_reasons: ["价格符合预算"],
        match_risks: [],
        status: "active",
      },
    ]);
    const reply = await answerPlatformShoppingQuestion({
      question: "预算 15 万以内的家用 SUV",
      messages: [{ role: "user", content: "预算 15 万以内的家用 SUV" }],
      stores: [demoStore(["category"])],
    });
    expect(reply.model).toBeNull();
    expect(reply.toolCalls).toEqual([
      "search_public_products",
      "show_products",
    ]);
    expect(reply.recommendations).toHaveLength(1);
    expect(reply.uiActions).toEqual([
      expect.objectContaining({
        type: "products",
        productIds: ["o1"],
      }),
    ]);
    expect(searchPublicStoreOffers).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          budget: { maximum: 150_000, currency: "CNY" },
          requirements: [],
        },
      }),
    );
  });
});
