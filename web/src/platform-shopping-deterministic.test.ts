import { afterEach, describe, expect, it, vi } from "vitest";

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
  getPlatformRouterEffectiveStatus: () => ({ source: "managed", ready: false }),
  readManagedPlatformRouterConfig: () => null,
}));

import {
  answerPlatformShoppingQuestion,
  PlatformAssistantUnavailableError,
} from "./platform-router";
import type { PublicStore } from "./store-directory";

afterEach(() => {
  vi.clearAllMocks();
});

function demoStore(): PublicStore {
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
    publicFields: ["category"],
    tenantId: "22222222-2222-4222-8222-222222222222",
    domainId: "33333333-3333-4333-8333-333333333333",
  };
}

describe("shopping assistant without AI gateway", () => {
  it("fails closed instead of inventing a deterministic catalog", async () => {
    await expect(
      answerPlatformShoppingQuestion({
        question: "我想买辆车",
        messages: [{ role: "user", content: "我想买辆车" }],
        stores: [demoStore()],
      }),
    ).rejects.toBeInstanceOf(PlatformAssistantUnavailableError);

    await expect(
      answerPlatformShoppingQuestion({
        question: "预算 15 万以内的家用 SUV",
        messages: [{ role: "user", content: "预算 15 万以内的家用 SUV" }],
        stores: [demoStore()],
      }),
    ).rejects.toMatchObject({
      message: "商城 AI 导购尚未配置完整，请稍后再试。",
    });
  });
});
