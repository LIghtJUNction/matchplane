import { describe, expect, it } from "vitest";

import {
  normalizeEndpoint,
  normalizeManagedRouterInput,
  normalizeProtocol,
  PlatformRouterConfigValidationError,
} from "./platform-router-config/contract";

describe("managed router provider contract", () => {
  it.each([
    "openai-compatible",
    "anthropic-messages",
    "gemini-generate-content",
  ] as const)("accepts the known %s protocol", (protocol) => {
    expect(normalizeProtocol(protocol)).toBe(protocol);
  });

  it("rejects unknown protocols", () => {
    expect(() => normalizeProtocol("openrouter-chat")).toThrow(
      PlatformRouterConfigValidationError,
    );
  });

  it.each([
    "https://provider.example/v1",
    "https://api.anthropic.com",
    "https://generativelanguage.googleapis.com",
  ])("accepts a safe HTTPS provider base: %s", (endpoint) => {
    expect(normalizeEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    "http://provider.example",
    "https://user:password@provider.example",
    "https://provider.example/v1?key=value",
    "https://provider.example/v1#fragment",
    "https://127.0.0.1/v1",
  ])("rejects an unsafe provider base: %s", (endpoint) => {
    expect(() => normalizeEndpoint(endpoint)).toThrow(
      PlatformRouterConfigValidationError,
    );
  });

  it("requires a bounded nonempty manual model ID without changing stored schema", () => {
    const input = {
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      protocol: "anthropic-messages" as const,
      enabled: true,
      apiKey: "write-only-and-not-stored-here",
    };
    const normalized = normalizeManagedRouterInput(
      input,
      "platform-router-key-11111111-1111-4111-8111-111111111111.key",
    );

    expect(normalized).toMatchObject({
      endpoint: input.endpoint,
      model: input.model,
      protocol: input.protocol,
      enabled: true,
      credentialFile:
        "platform-router-key-11111111-1111-4111-8111-111111111111.key",
    });
    expect(normalized).not.toHaveProperty("apiKey");
    for (const model of [
      " ",
      "x".repeat(257),
      "model with spaces",
      "model\nheader",
      "/leading/path",
      "model@revision",
    ]) {
      expect(() =>
        normalizeManagedRouterInput(
          { ...input, model },
          normalized.credentialFile,
        ),
      ).toThrow(PlatformRouterConfigValidationError);
    }
    expect(
      normalizeManagedRouterInput(
        {
          ...input,
          endpoint: "https://provider.example",
          protocol: "openai-compatible",
          model: "accounts/fireworks/models/deepseek-r1:free",
        },
        normalized.credentialFile,
      ).model,
    ).toBe("accounts/fireworks/models/deepseek-r1:free");
    for (const model of ["models/gemini-2.5-flash", "gemini:latest"]) {
      expect(() =>
        normalizeManagedRouterInput(
          {
            ...input,
            endpoint: "https://generativelanguage.googleapis.com",
            protocol: "gemini-generate-content",
            model,
          },
          normalized.credentialFile,
        ),
      ).toThrow(PlatformRouterConfigValidationError);
    }
  });
});
