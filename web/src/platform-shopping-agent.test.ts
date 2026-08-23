import { afterEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
const createOpenAICompatible = vi.hoisted(() =>
  vi.fn(() => ({
    chatModel: vi.fn(() => ({ modelId: "shopping-model" })),
  })),
);
const searchPublicStoreOffers = vi.hoisted(() =>
  vi.fn(
    async (
      _input: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => [],
  ),
);

vi.mock("ai", () => ({
  generateText,
  pruneMessages: ({ messages }: { messages: unknown[] }) => messages,
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

import {
  answerPlatformShoppingQuestion,
  applyShoppingMemoryDefaults,
  compactShoppingConversation,
  inferShoppingIntent,
  reviseShoppingMemoryWithAi,
} from "./platform-router";

afterEach(() => {
  generateText.mockReset();
  createOpenAICompatible.mockClear();
  searchPublicStoreOffers.mockClear();
});

describe("platform shopping agent", () => {
  it("instructs the model to resolve short follow-ups from the active conversation", async () => {
    generateText.mockResolvedValueOnce({
      text: "你是想了解李泰阳的近况、职业信息，还是想联系或邀请他？",
      usage: { inputTokens: 30, outputTokens: 18, totalTokens: 48 },
      steps: [{ toolCalls: [] }],
    });
    const messages = [
      { role: "user" as const, content: "李泰阳怎么卖" },
      {
        role: "assistant" as const,
        content: "你说的是商品还是人？",
      },
      { role: "user" as const, content: "人" },
      {
        role: "assistant" as const,
        content: "你想了解这个人的哪一方面？",
      },
      { role: "user" as const, content: "现在有什么" },
    ];

    const reply = await answerPlatformShoppingQuestion({
      question: "现在有什么",
      messages,
      stores: [],
    });

    expect(reply.text).toContain("李泰阳");
    const options = generateText.mock.calls[0]?.[0];
    expect(options.messages).toEqual(messages);
    expect(options.system).toContain(
      "短回答、省略句和纠正必须优先解释为对上一个问题的回答",
    );
    expect(options.system).toContain(
      "同一个模糊点不要连续问两次泛化的“请再具体一点”",
    );
    expect(options.system).toContain("不能帮助交易人");
  });

  it("uses AI SDK pruning and folds older user facts into bounded context", () => {
    const messages = Array.from({ length: 15 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === 0
          ? "记住苹果，稍后我会问你"
          : `${index % 2 === 0 ? "用户" : "助手"}第 ${index} 轮`,
    }));

    const compacted = compactShoppingConversation(messages);

    expect(compacted.messages).toHaveLength(10);
    expect(compacted.olderUserContext).toContain("记住苹果");
    expect(compacted.messages.at(-1)).toEqual({
      role: "user",
      content: "用户第 14 轮",
    });
  });

  it("extracts hard budget, year, and mileage constraints from user context", () => {
    expect(
      inferShoppingIntent([
        {
          role: "user",
          content: "预算11万元以内，2022年及以后，里程不超过3万公里",
        },
      ]),
    ).toEqual({
      budget: { maximum: 110_000, currency: "CNY" },
      requirements: [
        { field: "year", value: "2022", mode: "must", operator: "gte" },
        { field: "mileage", value: "30000", mode: "must", operator: "lte" },
      ],
    });
  });

  it("uses structured AI output to apply a natural-language memory correction", async () => {
    generateText.mockImplementationOnce(async (options) => {
      await options.tools.apply_memory_revision.execute({
        message: "已把预算改为 8000 元，并删除品牌偏好。",
        facts: [
          { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
        ],
      });
      return {
        text: "",
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
        steps: [{ toolCalls: [{ toolName: "apply_memory_revision" }] }],
      };
    });
    const admitCall = vi.fn(async () => undefined);

    const revision = await reviseShoppingMemoryWithAi({
      suggestion: "预算改成 8000 元，删掉品牌偏好",
      memory: {
        enabled: true,
        facts: [
          { kind: "budget", key: "maximum", value: "5000", currency: "CNY" },
          { kind: "preference", key: "notes", value: "偏好 A 品牌" },
        ],
        version: 2,
        updatedAt: "2026-08-22T08:00:00.000Z",
      },
      admitCall,
    });

    expect(revision).toEqual(
      expect.objectContaining({
        message: "已把预算改为 8000 元，并删除品牌偏好。",
        facts: [
          { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
        ],
        model: "shopping-model",
      }),
    );
    expect(admitCall).toHaveBeenCalledOnce();
    expect(generateText.mock.calls[0]?.[0].messages[0].content).toContain(
      "偏好 A 品牌",
    );
    expect(generateText.mock.calls[0]?.[0].messages[0].content).toContain(
      "删掉品牌偏好",
    );
  });

  it("uses durable memory only as a default and exposes it through a bounded recall tool", async () => {
    expect(
      applyShoppingMemoryDefaults(
        { budget: { maximum: 5_000, currency: "CNY" }, requirements: [] },
        { budget: { maximum: 8_000, currency: "CNY" }, requirements: [] },
      ),
    ).toEqual({
      budget: { maximum: 8_000, currency: "CNY" },
      requirements: [],
    });

    let recalled: unknown;
    searchPublicStoreOffers.mockResolvedValueOnce([]);
    generateText.mockImplementationOnce(async (options) => {
      recalled = await options.tools.recall_shopping_memory.execute({});
      return {
        text: "我会按你保存的通勤和轻便偏好来推荐。",
        usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
        steps: [{ toolCalls: [{ toolName: "recall_shopping_memory" }] }],
      };
    });
    const reply = await answerPlatformShoppingQuestion({
      question: "帮我推荐一款合适的商品",
      messages: [{ role: "user", content: "帮我推荐一款合适的商品" }],
      stores: [],
      memory: {
        enabled: true,
        facts: [
          { kind: "budget", key: "maximum", value: "5000", currency: "CNY" },
          { kind: "purpose", key: "primary", value: "日常通勤" },
          { kind: "preference", key: "notes", value: "轻便" },
        ],
        version: 2,
        updatedAt: "2026-08-22T08:00:00.000Z",
      },
    });

    expect(recalled).toEqual({
      facts: [
        { kind: "budget", key: "maximum", value: "5000", currency: "CNY" },
        { kind: "purpose", key: "primary", value: "日常通勤" },
        { kind: "preference", key: "notes", value: "轻便" },
      ],
    });
    expect(reply.toolCalls).toEqual(["recall_shopping_memory"]);
    const options = generateText.mock.calls.at(-1)?.[0];
    expect(options.system).toContain("用户已启用跨会话购物记忆");
    expect(options.system).not.toContain("日常通勤");
    expect(searchPublicStoreOffers).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          budget: { maximum: 5_000, currency: "CNY" },
          requirements: [],
        },
      }),
    );
  });

  it("lets AI update the durable summary after recalling the current memory", async () => {
    const updateMemory = vi.fn(async (facts) => ({
      enabled: true,
      facts,
      version: 3,
      updatedAt: "2026-08-22T09:00:00.000Z",
    }));
    let recalledAfterUpdate: unknown;
    generateText.mockImplementationOnce(async (options) => {
      await options.tools.recall_shopping_memory.execute({});
      await options.tools.update_shopping_memory.execute({
        facts: [
          { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
          { kind: "purpose", key: "primary", value: "日常通勤" },
        ],
      });
      recalledAfterUpdate = await options.tools.recall_shopping_memory.execute(
        {},
      );
      return {
        text: "我已经把长期预算改为 8000 元，并记住主要用于日常通勤。",
        usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
        steps: [
          {
            toolCalls: [
              { toolName: "recall_shopping_memory" },
              { toolName: "update_shopping_memory" },
            ],
          },
        ],
      };
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "以后预算按 8000 元，主要是日常通勤",
      messages: [
        { role: "user", content: "以后预算按 8000 元，主要是日常通勤" },
      ],
      stores: [],
      memory: {
        enabled: true,
        facts: [
          { kind: "budget", key: "maximum", value: "5000", currency: "CNY" },
        ],
        version: 2,
        updatedAt: "2026-08-22T08:00:00.000Z",
      },
      updateMemory,
    });

    expect(updateMemory).toHaveBeenCalledWith([
      { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
      { kind: "purpose", key: "primary", value: "日常通勤" },
    ]);
    expect(recalledAfterUpdate).toEqual({
      facts: [
        { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
        { kind: "purpose", key: "primary", value: "日常通勤" },
      ],
    });
    expect(reply.toolCalls).toEqual([
      "recall_shopping_memory",
      "update_shopping_memory",
    ]);
    expect(reply.modelCalls).toBe(1);
  });

  it("confirms a completed memory update when the model omits final prose", async () => {
    const updateMemory = vi.fn(async (facts) => ({
      enabled: true,
      facts,
      version: 4,
      updatedAt: "2026-08-22T10:00:00.000Z",
    }));
    generateText.mockImplementationOnce(async (options) => {
      await options.tools.update_shopping_memory.execute({
        facts: [
          { kind: "budget", key: "maximum", value: "9000", currency: "CNY" },
        ],
      });
      return {
        text: "",
        finishReason: "stop",
        usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
        steps: [{ toolCalls: [{ toolName: "update_shopping_memory" }] }],
      };
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "把长期预算改成 9000 元",
      messages: [{ role: "user", content: "把长期预算改成 9000 元" }],
      stores: [],
      memory: { enabled: true, facts: [], version: 3, updatedAt: null },
      updateMemory,
    });

    expect(updateMemory).toHaveBeenCalledOnce();
    expect(reply.text).toBe("购物记忆已按你刚才的要求更新。");
    expect(reply.modelCalls).toBe(1);
  });

  it("returns a bounded choice UI when AI asks the user for a key condition", async () => {
    generateText.mockImplementationOnce(async (options) => {
      await options.tools.ask_user.execute({
        question: "你更看重哪一点？",
        options: [
          { label: "价格更低", value: "我更看重价格" },
          { label: "质量更好", value: "我更看重质量" },
        ],
      });
      return {
        text: "先选一个更重要的方向。",
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        steps: [{ toolCalls: [{ toolName: "ask_user" }] }],
      };
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "帮我挑一个",
      messages: [{ role: "user", content: "帮我挑一个" }],
      stores: [],
    });

    expect(reply.uiActions).toEqual([
      {
        type: "choice",
        id: "choice-1",
        question: "你更看重哪一点？",
        options: [
          { id: "option-1", label: "价格更低", value: "我更看重价格" },
          { id: "option-2", label: "质量更好", value: "我更看重质量" },
        ],
      },
    ]);
    expect(reply.recommendations).toEqual([]);
  });

  it("keeps choice UI available when a compatible model answers without a tool call", async () => {
    generateText.mockResolvedValueOnce({
      text: "先确认一个方向。",
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
      steps: [{ toolCalls: [] }],
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "先问我一个问题并给我几个选项",
      messages: [{ role: "user", content: "先问我一个问题并给我几个选项" }],
      stores: [],
    });

    expect(reply.toolCalls).toEqual(["ask_user"]);
    expect(reply.uiActions[0]).toEqual(
      expect.objectContaining({
        type: "choice",
        question: "你想先从哪一项开始缩小范围？",
      }),
    );
    expect(reply.recommendations).toEqual([]);
  });

  it("performs precise multi-product retrieval across multiple tool-using turns", async () => {
    const products = [
      {
        offer_id: "offer-a",
        display_name: "轻薄本 A",
        store_name: "电子店",
        attributes: { description: "通勤，16GB，1.2kg", memory_gb: 16 },
        terms: { amount_minor: "399900", currency: "CNY", currency_scale: 2 },
        platform_path: "/electronics",
      },
      {
        offer_id: "offer-b",
        display_name: "轻薄本 B",
        store_name: "电子店",
        attributes: { description: "通勤，32GB，1.3kg", memory_gb: 32 },
        terms: { amount_minor: "459900", currency: "CNY", currency_scale: 2 },
        platform_path: "/electronics",
      },
    ];
    searchPublicStoreOffers.mockResolvedValue(products);
    generateText
      .mockImplementationOnce(async (options) => {
        await options.tools.list_public_stores.execute({});
        await options.tools.search_public_products.execute({
          query: "通勤轻薄本",
          budget: { maximum: 5_000, currency: "CNY" },
          requirements: [
            { field: "memory_gb", value: "16", mode: "must", operator: "gte" },
          ],
        });
        await options.tools.show_products.execute({
          productIds: ["offer-a", "offer-b"],
        });
        return {
          text: "找到轻薄本 A 和轻薄本 B。",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          steps: [
            {
              toolCalls: [
                { toolName: "list_public_stores" },
                { toolName: "search_public_products" },
                { toolName: "show_products" },
              ],
            },
          ],
        };
      })
      .mockImplementationOnce(async (options) => {
        await options.tools.list_public_stores.execute({});
        await options.tools.search_public_products.execute({
          query: "刚才两款通勤轻薄本",
          budget: { maximum: 5_000, currency: "CNY" },
          requirements: [
            { field: "memory_gb", value: "16", mode: "must", operator: "gte" },
          ],
        });
        await options.tools.show_products.execute({
          productIds: ["offer-a", "offer-b"],
        });
        await options.tools.compare_products.execute({
          productIds: ["offer-a", "offer-b"],
        });
        await options.tools.calculate_total.execute({
          amounts: [399_900, 459_900],
          quantities: [1, 1],
        });
        return {
          text: "两款合计 CNY 8598.00。",
          usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
          steps: [
            {
              toolCalls: [
                { toolName: "list_public_stores" },
                { toolName: "search_public_products" },
                { toolName: "show_products" },
                { toolName: "compare_products" },
                { toolName: "calculate_total" },
              ],
            },
          ],
        };
      });
    const stores = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "electronics",
        path: "/electronics",
        displayName: "电子店",
        description: "电脑",
        integrationKind: "hosted" as const,
        capabilities: [],
        agentStages: [],
        agentSkills: [],
        tenantId: "22222222-2222-4222-8222-222222222222",
        domainId: "33333333-3333-4333-8333-333333333333",
      },
    ];

    const first = await answerPlatformShoppingQuestion({
      question: "预算 5000，至少 16GB，找两款通勤轻薄本",
      messages: [
        { role: "user", content: "预算 5000，至少 16GB，找两款通勤轻薄本" },
      ],
      stores,
    });
    const second = await answerPlatformShoppingQuestion({
      question: "比较刚才两款并算合计",
      messages: [
        { role: "user", content: "预算 5000，至少 16GB，找两款通勤轻薄本" },
        { role: "assistant", content: first.text },
        { role: "user", content: "比较刚才两款并算合计" },
      ],
      stores,
    });

    expect(first.recommendations).toHaveLength(2);
    expect(first.modelCalls).toBe(1);
    expect(second.modelCalls).toBe(1);
    expect(first.toolCalls).toEqual([
      "list_public_stores",
      "search_public_products",
      "show_products",
    ]);
    expect(second.toolCalls).toEqual([
      "list_public_stores",
      "search_public_products",
      "show_products",
      "compare_products",
      "calculate_total",
    ]);
    expect(searchPublicStoreOffers).toHaveBeenCalledTimes(4);
    expect(searchPublicStoreOffers.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        narrative: "刚才两款通勤轻薄本",
        intent: expect.objectContaining({
          budget: { maximum: 5_000, currency: "CNY" },
          requirements: [
            { field: "memory_gb", value: "16", mode: "must", operator: "gte" },
          ],
        }),
      }),
    );
  });

  it("returns the real choice question when the model finishes without prose", async () => {
    generateText.mockImplementation(async (options) => {
      await options.tools.ask_user.execute({
        question: "你具体想找什么？",
        options: [
          { label: "商品", value: "帮我找商品" },
          { label: "店铺", value: "帮我找店铺" },
        ],
      });
      return {
        text: "",
        finishReason: "stop",
        usage: { inputTokens: 21, outputTokens: 17, totalTokens: 38 },
        steps: [{ toolCalls: [{ toolName: "ask_user" }] }],
      };
    });
    const admitCall = vi.fn(async () => undefined);

    const reply = await answerPlatformShoppingQuestion({
      question: "帮我找啊",
      messages: [{ role: "user", content: "帮我找啊" }],
      stores: [],
      admitCall,
    });

    expect(reply.text).toBe("你具体想找什么？");
    expect(reply.uiActions).toEqual([
      expect.objectContaining({
        type: "choice",
        question: "你具体想找什么？",
      }),
    ]);
    expect(reply.modelCalls).toBe(1);
    expect(admitCall).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("uses retrieved products when the model finishes without prose", async () => {
    searchPublicStoreOffers.mockResolvedValue([
      {
        offer_id: "offer-a",
        display_name: "通勤轻薄本 A",
        store_name: "电子店",
        attributes: { description: "轻便通勤" },
        terms: { amount_minor: "499900", currency: "CNY", currency_scale: 2 },
        platform_path: "/electronics",
      },
    ]);
    generateText.mockImplementation(async (options) => {
      await options.tools.search_public_products.execute({
        query: "通勤轻薄本",
        requirements: [],
      });
      return {
        text: "",
        finishReason: "stop",
        usage: { inputTokens: 31, outputTokens: 12, totalTokens: 43 },
        steps: [{ toolCalls: [{ toolName: "search_public_products" }] }],
      };
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "帮我找通勤轻薄本",
      messages: [{ role: "user", content: "帮我找通勤轻薄本" }],
      stores: [],
    });

    expect(reply.text).toContain("通勤轻薄本 A（CNY 4999.00）");
    expect(reply.recommendations).toHaveLength(1);
    expect(reply.toolCalls).toEqual([
      "search_public_products",
      "show_products",
    ]);
    expect(reply.modelCalls).toBe(1);
  });

  it("turns an empty final completion after product search into an honest no-results reply", async () => {
    searchPublicStoreOffers.mockResolvedValue([]);
    generateText.mockImplementation(async (options) => {
      await options.tools.search_public_products.execute({
        query: "通勤电脑",
        requirements: [],
      });
      return {
        text: "不如看看无关的二手车。",
        finishReason: "length",
        usage: { inputTokens: 27, outputTokens: 320, totalTokens: 347 },
        steps: [{ toolCalls: [{ toolName: "search_public_products" }] }],
      };
    });
    const admitCall = vi.fn(async () => undefined);

    const reply = await answerPlatformShoppingQuestion({
      question: "帮我找通勤电脑",
      messages: [{ role: "user", content: "帮我找通勤电脑" }],
      stores: [],
      admitCall,
    });

    expect(reply.text).toContain("暂时没有找到匹配的公开在售商品");
    expect(reply.text).not.toContain("二手车");
    expect(reply.recommendations).toEqual([]);
    expect(reply.modelCalls).toBe(1);
    expect(admitCall).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("uses AI SDK tools with a bounded, server-side tool loop", async () => {
    generateText.mockResolvedValue({
      text: "我会核实**公开店铺**和`商品`，给你比较合适的选择。",
      usage: { inputTokens: 17, outputTokens: 11, totalTokens: 28 },
      steps: [
        { toolCalls: [{ toolName: "list_public_stores" }] },
        { toolCalls: [] },
      ],
    });
    const admitCall = vi.fn(async () => undefined);

    const reply = await answerPlatformShoppingQuestion({
      question: "想了解如何挑选通勤电脑",
      messages: [
        { role: "user", content: "记住我偏好轻薄" },
        { role: "assistant", content: "记住了。" },
        { role: "user", content: "想了解如何挑选通勤电脑" },
      ],
      stores: [
        {
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
        },
      ],
      admitCall,
    });

    expect(reply).toEqual(
      expect.objectContaining({
        text: "我会核实公开店铺和商品，给你比较合适的选择。",
        model: "shopping-model",
      }),
    );
    expect(reply.modelCalls).toBe(2);
    expect(admitCall).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://router.example.com/v1",
        apiKey: "server-only-key",
      }),
    );
    expect(generateText).toHaveBeenCalledTimes(1);

    const options = generateText.mock.calls[0]?.[0];
    expect(options.tools).toEqual(
      expect.objectContaining({
        ask_user: expect.anything(),
        list_public_stores: expect.anything(),
        search_public_products: expect.anything(),
        show_products: expect.anything(),
        compare_products: expect.anything(),
        calculate_total: expect.anything(),
        calculate_numbers: expect.anything(),
      }),
    );
    expect(options.stopWhen).toEqual({ count: 4 });
    expect(options.messages).toEqual([
      { role: "user", content: "记住我偏好轻薄" },
      { role: "assistant", content: "记住了。" },
      { role: "user", content: "想了解如何挑选通勤电脑" },
    ]);
    expect(options.providerOptions).toEqual({
      matchplane: { reasoningEffort: "low" },
    });
    expect(options.prepareStep({ stepNumber: 0 })).toEqual({
      toolChoice: "auto",
    });
    expect(options.prepareStep({ stepNumber: 1 })).toEqual({
      toolChoice: "auto",
    });
    expect(options.prepareStep({ stepNumber: 2 })).toEqual({
      toolChoice: "auto",
    });
    expect(options.prepareStep({ stepNumber: 3 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });

    searchPublicStoreOffers.mockResolvedValueOnce([
      {
        offer_id: "offer-1",
        display_name: "Dogfood 测试商品",
        store_name: "Dogfood 测试商店",
        attributes: { description: "端到端验证" },
        terms: { amount_minor: "1234", currency: "CNY", currency_scale: 2 },
        platform_path: "/dogfood",
      },
    ]);
    await expect(
      options.tools.search_public_products.execute({
        query: "预算 20 元的测试商品",
        requirements: [],
      }),
    ).resolves.toEqual([expect.objectContaining({ price: "CNY 12.34" })]);
  });

  it("keeps store AI active while proposing idempotent staff handoff and contact consent", async () => {
    searchPublicStoreOffers.mockResolvedValueOnce([
      {
        offer_id: "offer-1",
        display_name: "测试商品",
        store_name: "测试小店",
        attributes: { description: "适合用户需求" },
        terms: { amount_minor: "9900", currency: "CNY", currency_scale: 2 },
        platform_path: "/test-store",
      },
    ]);
    generateText.mockResolvedValueOnce({
      text: "请再具体一点。",
      usage: { inputTokens: 24, outputTokens: 16, totalTokens: 40 },
      steps: [{ toolCalls: [] }],
    });

    const reply = await answerPlatformShoppingQuestion({
      question:
        "我想买这件商品，请让店员确认交付时间，并询问我是否同意交换联系方式。",
      messages: [
        {
          role: "user",
          content:
            "我想买这件商品，请让店员确认交付时间，并询问我是否同意交换联系方式。",
        },
      ],
      stores: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "test-store",
          path: "/test-store",
          displayName: "测试小店",
          description: "测试商品",
          integrationKind: "hosted",
          capabilities: [],
          agentStages: [],
          agentSkills: [],
          tenantId: "22222222-2222-4222-8222-222222222222",
          domainId: "33333333-3333-4333-8333-333333333333",
        },
      ],
      storeContext: { path: "/test-store", name: "测试小店" },
    });

    expect(reply.text).toContain("已通知店员介入");
    expect(reply.text).toContain("未经你确认不会交换");
    expect(reply.uiActions).toEqual([
      {
        type: "human_handoff",
        id: "human-handoff-1",
        summary:
          "我想买这件商品，请让店员确认交付时间，并询问我是否同意交换联系方式。",
        intent: "high",
        productIds: ["offer-1"],
      },
      {
        type: "contact_consent",
        id: "contact-consent-1",
        reason:
          "我想买这件商品，请让店员确认交付时间，并询问我是否同意交换联系方式。",
        productId: "offer-1",
      },
      { type: "products", productIds: ["offer-1"] },
    ]);
    expect(searchPublicStoreOffers).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].system).toContain("AI 店长");
    expect(generateText.mock.calls[0]?.[0].system).toContain(
      "不能替用户同意",
    );
  });
});
