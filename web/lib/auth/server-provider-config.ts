import "server-only";

import type {
  PublicAIProviderConfig,
  PublicOAuthProviderConfig,
  PublicPlatformSettings,
} from "./provider-config";

export type AIWireProtocol =
  | "openai-compatible"
  | "anthropic-messages"
  | "gemini-generate-content";

export type OAuthEndpointContract =
  | { discoveryUrl: string }
  | {
      authorizationUrl: string;
      tokenUrl: string;
      userInfoUrl: string;
    };

/** Server-only OAuth configuration. `credentialSecretRef` is never a raw secret. */
export interface ServerOAuthProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  clientId: string;
  credentialSecretRef: string;
  endpoints: OAuthEndpointContract;
  scopes: string[];
}

/** Server-only AI configuration. The model protocol remains explicit for custom gateways. */
export interface ServerAIProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: string;
  model: string;
  protocol: AIWireProtocol;
  credentialSecretRef: string;
}

export interface ServerPlatformSettings {
  authCapabilities: PublicPlatformSettings["authCapabilities"];
  oauthProviders: ServerOAuthProviderConfig[];
  aiProviders: ServerAIProviderConfig[];
  defaultAiProviderId?: string;
}

export function isConfiguredOAuthProvider(provider: ServerOAuthProviderConfig): boolean {
  return provider.enabled
    && isProviderId(provider.id)
    && provider.name.trim().length > 0
    && provider.clientId.trim().length > 0
    && isSecretReference(provider.credentialSecretRef)
    && provider.scopes.some((scope) => scope.trim().length > 0)
    && hasValidOAuthEndpoints(provider.endpoints);
}

export function isConfiguredAIProvider(provider: ServerAIProviderConfig): boolean {
  return provider.enabled
    && isProviderId(provider.id)
    && provider.name.trim().length > 0
    && provider.model.trim().length > 0
    && isHttpsUrl(provider.endpoint)
    && isSecretReference(provider.credentialSecretRef);
}

export function publicPlatformSettings(settings: ServerPlatformSettings): PublicPlatformSettings {
  const oauthProviders = settings.oauthProviders.flatMap((provider): PublicOAuthProviderConfig[] =>
    isConfiguredOAuthProvider(provider) ? [{ id: provider.id, name: provider.name }] : [],
  );
  const aiProviders = settings.aiProviders.flatMap((provider): PublicAIProviderConfig[] =>
    isConfiguredAIProvider(provider)
      ? [{ id: provider.id, name: provider.name, model: provider.model }]
      : [],
  );
  const defaultAiProviderId = settings.defaultAiProviderId && aiProviders.some((provider) => provider.id === settings.defaultAiProviderId)
    ? settings.defaultAiProviderId
    : undefined;
  return {
    authCapabilities: settings.authCapabilities,
    oauthProviders,
    aiProviders,
    ...(defaultAiProviderId ? { defaultAiProviderId } : {}),
  };
}

function hasValidOAuthEndpoints(endpoints: OAuthEndpointContract): boolean {
  if ("discoveryUrl" in endpoints) return isHttpsUrl(endpoints.discoveryUrl);
  return isHttpsUrl(endpoints.authorizationUrl)
    && isHttpsUrl(endpoints.tokenUrl)
    && isHttpsUrl(endpoints.userInfoUrl);
}

function isProviderId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,127}$/.test(value);
}

function isSecretReference(value: string): boolean {
  return /^(env|file):\/\/.+/.test(value.trim());
}

function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}
