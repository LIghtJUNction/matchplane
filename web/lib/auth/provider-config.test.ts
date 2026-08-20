import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { availableOAuthProviders } from "./provider-config";
import { publicPlatformSettings } from "./server-provider-config";

describe("provider configuration boundaries", () => {
  it("does not serialize OAuth or AI credentials into the public settings DTO", () => {
    const settings = publicPlatformSettings({
      authCapabilities: ["password", "passkey"],
      oauthProviders: [{
        id: "example-oauth",
        name: "Example OAuth",
        enabled: true,
        clientId: "server-client-id",
        credentialSecretRef: "file:///run/secrets/oauth/example",
        endpoints: { discoveryUrl: "https://identity.example/.well-known/openid-configuration" },
        scopes: ["openid"],
      }],
      aiProviders: [{
        id: "model-gateway",
        name: "Model gateway",
        enabled: true,
        endpoint: "https://models.example/v1/chat/completions",
        model: "operator/model",
        protocol: "openai-compatible",
        credentialSecretRef: "env://MATCHPLANE_MODEL_GATEWAY_KEY",
      }],
      defaultAiProviderId: "model-gateway",
    });

    expect(availableOAuthProviders(settings)).toEqual([{ id: "example-oauth", name: "Example OAuth" }]);
    expect(JSON.stringify(settings)).not.toContain("server-client-id");
  });

  it("does not advertise incomplete OAuth providers", () => {
    const settings = publicPlatformSettings({
      authCapabilities: ["password"],
      oauthProviders: [{
        id: "incomplete-oauth",
        name: "Incomplete OAuth",
        enabled: true,
        clientId: "client-id",
        credentialSecretRef: "file:///run/secrets/oauth/incomplete",
        endpoints: { discoveryUrl: "http://identity.example/discovery" },
        scopes: ["openid"],
      }],
      aiProviders: [],
    });

    expect(settings.oauthProviders).toEqual([]);
  });
});
