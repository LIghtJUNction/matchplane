import { describe, expect, it } from "vitest";

import { modelReasoningEffortsFromRecord } from "./platform-router-config";

describe("model reasoning capability metadata", () => {
  it("uses provider-declared levels without guessing from the model name", () => {
    expect(modelReasoningEffortsFromRecord({
      id: "provider-specific-model",
      supported_reasoning_efforts: ["minimal", "low", "high", "xhigh"],
    })).toEqual(["minimal", "low", "high", "xhigh"]);
  });

  it("accepts nested capability metadata and returns no levels when none are declared", () => {
    expect(modelReasoningEffortsFromRecord({
      capabilities: { reasoning: { levels: ["fast", "deep"] } },
    })).toEqual(["fast", "deep"]);
    expect(modelReasoningEffortsFromRecord({ id: "unknown-model" })).toEqual([]);
  });
});
