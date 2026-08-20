export type AuthProviderKind =
  | "phone"
  | "email"
  | "wechat"
  | "qq"
  | "alipay"
  | "google"
  | "oauth2";

export interface OAuthProviderConfig {
  id: string;
  name: string;
  kind: AuthProviderKind;
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scope?: string[];
}

export interface AIProviderConfig {
  id: string;
  name: string;
  provider: "openai" | "anthropic" | "gemini" | "custom";
  endpoint: string;
  model: string;
  enabled: boolean;
}

export interface PlatformSettings {
  authProviders: OAuthProviderConfig[];
  aiProviders: AIProviderConfig[];
}

export function enabledAuthProviders(settings: PlatformSettings) {
  return settings.authProviders.filter((provider) => provider.enabled);
}
