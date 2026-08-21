import { afterEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
const createOpenAICompatible = vi.hoisted(() => vi.fn(() => ({
  chatModel: vi.fn(() => ({ modelId: "shopping-model" })),
})));
const searchPublicStoreOffers = vi.hoisted(() => vi.fn(async () => []));

vi.mock("ai", () => ({
  generateText,
  stepCountIs: (count: number) => ({ count }),
  tool: <T>(definition: T) => definition,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

vi.mock("./lib/platform-router-config", () => ({
  readManagedPlatformRouterConfig: () => ({
    endpoint: "https://router.example.com",
    apiKey: "server-only-key",
    model: "shopping-model",
    protocol: "openai-compatible",
    enabled: true,
    assistantInstructions: "先问清用途。",
    assistantMaxOutputTokens: 320,
    assistantTemperature: 0.2,
    assistantMaxSteps: 4,
    assistantTimeoutMs: 12_000,
    assistantReasoningEffort: "low",
  }),
}));

vi.mock("./storefront-search", () => ({ searchPublicStoreOffers }));

import { answerPlatformShoppingQuestion } from "./platform-router";

afterEach(() => {
  generateText.mockReset();
  createOpenAICompatible.mockClear();
  searchPublicStoreOffers.mockClear();
});

describe("platform shopping agent", () => {
  it("uses AI SDK tools with a bounded, server-side tool loop", async () => {
    generateText.mockResolvedValue({
      text: "我会先核实公开店铺和商品，再给你比较合适的选择。",
      usage: { inputTokens: 17, outputTokens: 11, totalTokens: 28 },
    });
    const admitCall = vi.fn(async () => undefined);

    const reply = await answerPlatformShoppingQuestion({
      question: "预算 3000 元，想买通勤电脑",
      mode: "shopping",
      stores: [{
        id: "11111111-1111-4111-8111-111111111111",
        slug: "electronics",
        path: "/electronics",
        displayName: "电子店",
        description: "轻薄电脑",
        integrationKind: "hosted",
        capabilities: [],
        agentStages: [],
        agentSkills: [],
        tenantId: "22222222-2222-4222-8222-222222222222",
        domainId: "33333333-3333-4333-8333-333333333333",
      }],
      admitCall,
    });

    expect(reply).toEqual(expect.objectContaining({ text: "我会先核实公开店铺和商品，再给你比较合适的选择。", model: "shopping-model" }));
    expect(admitCall).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://router.example.com/v1",
      apiKey: "server-only-key",
    }));
    expect(generateText).toHaveBeenCalledTimes(1);

    const options = generateText.mock.calls[0]?.[0];
    expect(options.tools).toEqual(expect.objectContaining({
      list_public_stores: expect.anything(),
      search_public_products: expect.anything(),
      compare_products: expect.anything(),
      calculate_total: expect.anything(),
    }));
    expect(options.stopWhen).toEqual({ count: 4 });
    expect(options.providerOptions).toEqual({ matchplane: { reasoningEffort: "low" } });
    expect(options.prepareStep({ stepNumber: 0 })).toEqual({ activeTools: ["list_public_stores"], toolChoice: "auto" });
    expect(options.prepareStep({ stepNumber: 1 })).toEqual({ activeTools: ["search_public_products"], toolChoice: "auto" });
    expect(options.prepareStep({ stepNumber: 2 })).toEqual({ toolChoice: "auto" });
    expect(options.prepareStep({ stepNumber: 3 })).toEqual({ activeTools: [], toolChoice: "none" });
  });
});
