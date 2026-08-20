/**
 * Browser-safe provider availability returned by an administrator-controlled
 * server endpoint. This module deliberately contains no endpoint, client ID,
 * API key, or secret reference.
 */
export type AuthCapabilityKind =
  | "password"
  | "email_otp"
  | "phone_otp"
  | "magic_link"
  | "passkey"
  | "national_identity";

export interface PublicOAuthProviderConfig {
  id: string;
  name: string;
}

export interface PublicAIProviderConfig {
  id: string;
  name: string;
  model: string;
}

export interface PublicPlatformSettings {
  authCapabilities: AuthCapabilityKind[];
  oauthProviders: PublicOAuthProviderConfig[];
  aiProviders: PublicAIProviderConfig[];
  defaultAiProviderId?: string;
}

/** Returns the server-validated OAuth providers that are safe to advertise. */
export function availableOAuthProviders(settings: PublicPlatformSettings): PublicOAuthProviderConfig[] {
  return settings.oauthProviders;
}
