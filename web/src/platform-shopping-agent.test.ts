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
const searchPublicStoreOfferPage = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => {
    const items = await searchPublicStoreOffers(input);
    return {
      items,
      total: items.length,
      offset: Number(input.offset ?? 0),
      limit: Number(input.limit ?? 6),
      hasMore: false,
    };
  }),
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
    endpoint: "https://router.example.com/v1/chat/completions",
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

vi.mock("./storefront-search", () => ({
  searchPublicStoreOfferPage,
  searchPublicStoreOffers,
}));

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
  searchPublicStoreOfferPage.mockClear();
  searchPublicStoreOffers.mockClear();
});

describe("platform shopping agent", () => {
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

  it("rejects an empty model response instead of fabricating memory confirmation", async () => {
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

    await expect(
      answerPlatformShoppingQuestion({
        question: "把长期预算改成 9000 元",
        messages: [{ role: "user", content: "把长期预算改成 9000 元" }],
        stores: [],
        memory: { enabled: true, facts: [], version: 3, updatedAt: null },
        updateMemory,
      }),
    ).rejects.toThrow("AI 模型未返回有效回答");

    expect(updateMemory).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledOnce();
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
        kind: "question",
        question: "你更看重哪一点？",
        options: [
          { id: "option-1", label: "价格更低", value: "我更看重价格" },
          { id: "option-2", label: "质量更好", value: "我更看重质量" },
        ],
      },
    ]);
    expect(reply.recommendations).toEqual([]);
  });

  it("rejects a model that omits the required choice tool instead of inventing options", async () => {
    generateText.mockResolvedValueOnce({
      text: "先确认一个方向。",
      finishReason: "stop",
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
      steps: [{ toolCalls: [] }],
    });

    await expect(
      answerPlatformShoppingQuestion({
        question: "先问我一个问题并给我几个选项",
        messages: [{ role: "user", content: "先问我一个问题并给我几个选项" }],
        stores: [],
      }),
    ).rejects.toThrow("AI 模型未返回有效的澄清选项");
    expect(generateText).toHaveBeenCalledOnce();
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
          fields: ["memory_gb"],
        });
        await options.tools.show_product_comparison.execute({
          productIds: ["offer-a", "offer-b"],
          fields: ["memory_gb"],
          title: "轻薄本对比",
        });
        await options.tools.calculate_total.execute({
          items: [
            { productId: "offer-a", quantity: 1 },
            { productId: "offer-b", quantity: 1 },
          ],
        });
        await options.tools.show_price_summary.execute({
          items: [
            { productId: "offer-a", quantity: 1 },
            { productId: "offer-b", quantity: 1 },
          ],
          title: "两款合计",
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
                { toolName: "show_product_comparison" },
                { toolName: "calculate_total" },
                { toolName: "show_price_summary" },
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
      "show_product_comparison",
      "calculate_total",
      "show_price_summary",
    ]);
    expect(second.uiActions).toEqual([
      expect.objectContaining({
        type: "products",
        presentation: "comparison",
        title: "两款合计",
        comparison: expect.objectContaining({
          fields: ["store", "price", "memory_gb"],
        }),
        priceSummary: {
          currency: "CNY",
          currencyScale: 2,
          totalMinor: "859800",
          formatted: "CNY 8598.00",
        },
      }),
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

  it("returns grounded details, retrieval facets, and an explicit confirmation action", async () => {
    const products = [
      {
        offer_id: "offer-a",
        display_name: "轻薄本 A",
        store_name: "电子店",
        attributes: { description: "通勤", memory_gb: 16, color: "灰色" },
        terms: { amount_minor: "399900", currency: "CNY", currency_scale: 2 },
        platform_path: "/electronics",
        match_score: 0.93,
        match_reasons: ["符合预算"],
        match_risks: [],
      },
    ];
    searchPublicStoreOffers.mockResolvedValue(products);
    let details: unknown;
    let facets: unknown;
    generateText.mockImplementationOnce(async (options) => {
      await options.tools.search_public_products.execute({
        query: "轻薄本 A",
        requirements: [],
        storePaths: ["/electronics"],
        sort: "relevance",
        offset: 0,
        limit: 6,
      });
      details = await options.tools.get_product_details.execute({
        productIds: ["offer-a"],
      });
      facets = await options.tools.summarize_search_results.execute({});
      await options.tools.show_products.execute({
        productIds: ["offer-a"],
        title: "符合条件",
      });
      await options.tools.confirm_action.execute({
        question: "继续联系店铺？",
        confirmLabel: "继续",
        cancelLabel: "暂不",
        confirmValue: "确认继续联系店铺",
        cancelValue: "暂不联系",
      });
      return {
        text: "轻薄本 A 配备 16GB 内存；是否继续由你确认。",
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
        steps: [
          {
            toolCalls: [
              { toolName: "search_public_products" },
              { toolName: "get_product_details" },
              { toolName: "summarize_search_results" },
              { toolName: "show_products" },
              { toolName: "confirm_action" },
            ],
          },
        ],
      };
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "给我这款的参数，并提供继续或暂不两个选择",
      messages: [
        { role: "user", content: "给我这款的参数，并提供继续或暂不两个选择" },
      ],
      stores: [],
    });

    expect(details).toEqual({
      products: [
        expect.objectContaining({
          id: "offer-a",
          attributes: expect.objectContaining({ memory_gb: "16", color: "灰色" }),
          matchScore: 0.93,
          matchReasons: ["符合预算"],
        }),
      ],
    });
    expect(facets).toEqual(
      expect.objectContaining({
        productCount: 1,
        stores: [{ name: "电子店", count: 1 }],
        availableFields: expect.arrayContaining(["memory_gb", "color"]),
      }),
    );
    expect(reply.uiActions).toEqual([
      expect.objectContaining({
        type: "choice",
        kind: "confirmation",
        question: "继续联系店铺？",
      }),
      expect.objectContaining({
        type: "products",
        title: "符合条件",
        productIds: ["offer-a"],
      }),
    ]);
  });

  it("forces an explicit confirmation tool instead of relying on prose", async () => {
    generateText.mockImplementationOnce(async (options) => {
      await options.tools.confirm_action.execute({
        question: "继续执行下一步？",
        confirmLabel: "继续",
        cancelLabel: "取消",
        confirmValue: "确认继续执行下一步",
        cancelValue: "取消下一步",
      });
      return {
        text: "",
        finishReason: "tool-calls",
        usage: { inputTokens: 16, outputTokens: 8, totalTokens: 24 },
        steps: [{ toolCalls: [{ toolName: "confirm_action" }] }],
      };
    });

    const reply = await answerPlatformShoppingQuestion({
      question: "执行下一步前请让我确认是否继续",
      messages: [{ role: "user", content: "执行下一步前请让我确认是否继续" }],
      stores: [],
    });

    expect(reply.text).toBe("继续执行下一步？");
    expect(reply.toolCalls).toEqual(["confirm_action"]);
    expect(reply.uiActions).toEqual([
      {
        type: "choice",
        id: "choice-1",
        kind: "confirmation",
        question: "继续执行下一步？",
        options: [
          { id: "confirm", label: "继续", value: "确认继续执行下一步" },
          { id: "cancel", label: "取消", value: "取消下一步" },
        ],
      },
    ]);
    expect(generateText.mock.calls[0]?.[0].stopWhen).toEqual({ count: 1 });
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

  it("rejects comparison prose when the model skips the deterministic comparison tool", async () => {
    searchPublicStoreOffers.mockResolvedValue([
      {
        offer_id: "offer-a",
        display_name: "通勤轻薄本 A",
        store_name: "电子店",
        attributes: {},
        terms: { amount_minor: "499900", currency: "CNY", currency_scale: 2 },
        platform_path: "/electronics",
      },
      {
        offer_id: "offer-b",
        display_name: "通勤轻薄本 B",
        store_name: "电子店",
        attributes: {},
        terms: { amount_minor: "599900", currency: "CNY", currency_scale: 2 },
        platform_path: "/electronics",
      },
    ]);
    generateText.mockImplementation(async (options) => {
      await options.tools.search_public_products.execute({
        query: "通勤轻薄本",
        requirements: [],
      });
      return {
        text: "A 更便宜。",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        steps: [{ toolCalls: [{ toolName: "search_public_products" }] }],
      };
    });

    await expect(
      answerPlatformShoppingQuestion({
        question: "对比两款通勤轻薄本",
        messages: [{ role: "user", content: "对比两款通勤轻薄本" }],
        stores: [],
      }),
    ).rejects.toThrow("AI 模型未按协议完成必要的检索与工具调用");
  });

  it("rejects an empty model response instead of synthesizing a product answer", async () => {
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

    await expect(
      answerPlatformShoppingQuestion({
        question: "帮我找通勤轻薄本",
        messages: [{ role: "user", content: "帮我找通勤轻薄本" }],
        stores: [],
      }),
    ).rejects.toThrow("AI 模型未返回有效回答");
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("returns the model response without replacing it with a canned no-results answer", async () => {
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

    expect(reply.text).toBe("不如看看无关的二手车。");
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
        get_product_details: expect.anything(),
        summarize_search_results: expect.anything(),
        show_products: expect.anything(),
        compare_products: expect.anything(),
        show_product_comparison: expect.anything(),
        calculate_total: expect.anything(),
        show_price_summary: expect.anything(),
        confirm_action: expect.anything(),
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
    ).resolves.toEqual(
      expect.objectContaining({
        products: [expect.objectContaining({ price: "CNY 12.34" })],
        page: {
          total: 1,
          offset: 0,
          limit: 6,
          hasMore: false,
        },
      }),
    );
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

    expect(reply.text).toBe("请再具体一点。");
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
      { type: "products", productIds: ["offer-1"], presentation: "grid" },
    ]);
    expect(searchPublicStoreOffers).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].system).toContain("AI 店长");
    expect(generateText.mock.calls[0]?.[0].system).toContain("不能替用户同意");
  });
});
