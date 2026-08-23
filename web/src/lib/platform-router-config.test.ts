import { describe, expect, it, vi } from "vitest";

import {
  listManagedPlatformRouterModels,
  modelReasoningEffortsFromRecord,
} from "./platform-router-config";

describe("model reasoning capability metadata", () => {
  it("uses provider-declared levels without guessing from the model name", () => {
    expect(
      modelReasoningEffortsFromRecord({
        id: "provider-specific-model",
        supported_reasoning_efforts: ["minimal", "low", "high", "xhigh"],
      }),
    ).toEqual(["minimal", "low", "high", "xhigh"]);
  });

  it("accepts nested capability metadata and returns no levels when none are declared", () => {
    expect(
      modelReasoningEffortsFromRecord({
        capabilities: { reasoning: { levels: ["fast", "deep"] } },
      }),
    ).toEqual(["fast", "deep"]);
    expect(modelReasoningEffortsFromRecord({ id: "unknown-model" })).toEqual(
      [],
    );
    expect(
      modelReasoningEffortsFromRecord({ capabilities: "malformed" }),
    ).toEqual([]);
  });
});

describe("managed router model discovery", () => {
  it("rejects an endpoint when DNS includes a private address", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      listManagedPlatformRouterModels({
        endpoint: "https://provider.example",
        protocol: "openai-compatible",
        apiKey: "secret",
        fetcher,
        resolveAddresses: async () => ["93.184.216.34", "10.0.0.1"],
      }),
    ).rejects.toThrow("公网地址");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disables redirects after resolving a public endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      return new Response(
        JSON.stringify({ data: [{ id: "provider/model" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    await expect(
      listManagedPlatformRouterModels({
        endpoint: "https://provider.example",
        protocol: "openai-compatible",
        apiKey: "secret",
        fetcher,
        resolveAddresses: async () => ["93.184.216.34"],
      }),
    ).resolves.toEqual([{ id: "provider/model", reasoningEfforts: [] }]);
  });
});
