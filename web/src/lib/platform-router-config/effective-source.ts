import {
  isValidProviderModel,
  normalizeEndpoint,
  normalizeProtocol,
  PlatformRouterConfigValidationError,
  type ManagedPlatformRouterConfig,
  type ManagedRouterProtocol,
  type PlatformRouterEffectiveStatus,
} from "./contract";
import { getManagedPlatformRouterConfig } from "./lifecycle";

interface OriginAllowlistPolicy {
  configured: boolean;
  valid: boolean;
  origins: string[] | null;
}

export interface PlatformRouterProviderEnvironment {
  NODE_ENV?: string;
  MATCHPLANE_ROUTER_AI_URL?: string;
  MATCHPLANE_ROUTER_AI_MODEL?: string;
  MATCHPLANE_ROUTER_AI_KEY?: string;
  MATCHPLANE_ROUTER_AI_PROTOCOL?: string;
  MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS?: string;
}

export interface EnvironmentProviderStatus {
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  credentialConfigured: boolean;
  present: boolean;
  configured: boolean;
  originAllowlist: OriginAllowlistPolicy;
}

interface SelectedProviderStatus {
  source: PlatformRouterEffectiveStatus["source"];
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  enabled: boolean;
  credentialConfigured: boolean;
}

type PolicyCandidate = Pick<
  PlatformRouterEffectiveStatus,
  "model" | "protocol" | "enabled" | "credentialConfigured"
> & {
  source?: PlatformRouterEffectiveStatus["source"];
  endpoint?: string | null;
  endpointOrigin?: string | null;
};

export function getPlatformRouterEffectiveStatus(): PlatformRouterEffectiveStatus {
  return platformRouterEffectiveStatusFromReader(
    getManagedPlatformRouterConfig,
    readEnvironmentProviderStatus(),
  );
}

export function platformRouterEffectiveStatusFromReader(
  readManaged: () => ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
): PlatformRouterEffectiveStatus {
  try {
    return platformRouterEffectiveStatusFrom(readManaged(), environment);
  } catch {
    // A present but unreadable/corrupt managed generation must block the
    // environment fallback without inventing endpoint or model values.
    return unreadableManagedPlatformRouterEffectiveStatus(environment);
  }
}

export function unreadableManagedPlatformRouterEffectiveStatus(
  environment: EnvironmentProviderStatus,
): PlatformRouterEffectiveStatus {
  return {
    ready: false,
    code: "upstream_configuration",
    preferredHttpStatus: 451,
    source: "managed",
    managedOverridesEnvironment: environment.present,
    conflicts: { endpoint: null, model: null, protocol: null },
    endpointOrigin: null,
    model: null,
    protocol: null,
    enabled: false,
    credentialConfigured: false,
    originAllowlistApplied: environment.originAllowlist.configured,
    issues: ["managed_configuration_unreadable"],
  };
}

export function platformRouterEffectiveStatusFrom(
  managed: ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
): PlatformRouterEffectiveStatus {
  const selected = selectEffectiveProvider(managed, environment);
  const issues = platformRouterPolicyIssues(
    selected,
    environment.originAllowlist,
  );
  const ready = issues.length === 0;
  return {
    ready,
    code: ready ? "ready" : "upstream_configuration",
    preferredHttpStatus: ready ? null : 451,
    source: selected.source,
    managedOverridesEnvironment:
      selected.source === "managed" && environment.present,
    conflicts: managedEnvironmentConflicts(managed, environment),
    endpointOrigin: safeEndpointOrigin(selected.endpoint),
    model: selected.model,
    protocol: selected.protocol,
    enabled: selected.enabled,
    credentialConfigured: selected.credentialConfigured,
    originAllowlistApplied: environment.originAllowlist.configured,
    issues,
  };
}

export function platformRouterPolicyIssues(
  value: PolicyCandidate,
  originAllowlist: OriginAllowlistPolicy = readOriginAllowlistPolicy(
    process.env.MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS,
  ),
): string[] {
  const endpoint = value.endpoint ?? value.endpointOrigin ?? null;
  const normalizedEndpoint = endpoint ? safeNormalizedEndpoint(endpoint) : null;
  const normalizedEndpointOrigin = normalizedEndpoint
    ? safeUrlOrigin(normalizedEndpoint)
    : null;
  const issues: string[] = [];
  if (value.source === "unconfigured") issues.push("provider_not_configured");
  if (!value.enabled) issues.push("provider_not_enabled");
  if (!value.credentialConfigured) issues.push("credential_not_configured");
  if (!normalizedEndpoint) issues.push("endpoint_invalid");
  if (!isValidProviderModel(value.model, value.protocol))
    issues.push("model_invalid");
  if (!isKnownProtocol(value.protocol)) issues.push("protocol_invalid");
  if (!originAllowlist.valid) {
    issues.push("origin_allowlist_invalid");
  } else if (
    normalizedEndpointOrigin &&
    originAllowlist.origins &&
    !originAllowlist.origins.includes(normalizedEndpointOrigin)
  ) {
    issues.push("endpoint_origin_not_allowed");
  }
  return [...new Set(issues)];
}

export function readEnvironmentProviderStatus(
  environment: PlatformRouterProviderEnvironment = process.env as PlatformRouterProviderEnvironment,
): EnvironmentProviderStatus {
  const endpoint = environment.MATCHPLANE_ROUTER_AI_URL?.trim() || null;
  const model = environment.MATCHPLANE_ROUTER_AI_MODEL?.trim() || null;
  const credentialConfigured = Boolean(
    environment.MATCHPLANE_ROUTER_AI_KEY?.trim(),
  );
  const rawProtocol =
    environment.MATCHPLANE_ROUTER_AI_PROTOCOL?.trim() || undefined;
  const protocol = safeProtocol(rawProtocol);
  const present = Boolean(
    endpoint || model || credentialConfigured || rawProtocol,
  );
  const originAllowlist = readOriginAllowlistPolicy(
    environment.MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS,
  );
  const candidate: SelectedProviderStatus = {
    source: present ? "environment" : "unconfigured",
    endpoint,
    model,
    protocol,
    enabled: present,
    credentialConfigured,
  };
  return {
    endpoint,
    model,
    credentialConfigured,
    protocol,
    present,
    configured:
      present &&
      platformRouterPolicyIssues(candidate, originAllowlist).length === 0,
    originAllowlist,
  };
}

function selectEffectiveProvider(
  managed: ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
): SelectedProviderStatus {
  if (managed) {
    return {
      source: "managed",
      endpoint: managed.endpoint,
      model: managed.model,
      protocol: managed.protocol,
      enabled: managed.enabled,
      credentialConfigured: managed.credentialConfigured,
    };
  }
  if (environment.present) {
    return {
      source: "environment",
      endpoint: environment.endpoint,
      model: environment.model,
      protocol: environment.protocol,
      enabled: true,
      credentialConfigured: environment.credentialConfigured,
    };
  }
  return {
    source: "unconfigured",
    endpoint: null,
    model: null,
    protocol: null,
    enabled: false,
    credentialConfigured: false,
  };
}

function managedEnvironmentConflicts(
  managed: ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
): PlatformRouterEffectiveStatus["conflicts"] {
  if (!managed || !environment.present) {
    return { endpoint: false, model: false, protocol: false };
  }
  return {
    endpoint: Boolean(
      environment.endpoint &&
        endpointForComparison(environment.endpoint) !==
          endpointForComparison(managed.endpoint),
    ),
    model: Boolean(environment.model && environment.model !== managed.model),
    protocol: Boolean(
      environment.protocol && environment.protocol !== managed.protocol,
    ),
  };
}

function readOriginAllowlistPolicy(
  value: string | undefined,
): OriginAllowlistPolicy {
  const candidate = value?.trim();
  if (!candidate) return { configured: false, valid: true, origins: null };
  const entries = candidate.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) {
    return { configured: true, valid: false, origins: null };
  }
  const origins: string[] = [];
  for (const entry of entries) {
    const origin = safeExactHttpsOrigin(entry);
    if (!origin) return { configured: true, valid: false, origins: null };
    origins.push(origin);
  }
  return {
    configured: true,
    valid: true,
    origins: [...new Set(origins)],
  };
}

function safeExactHttpsOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }
  return safeNormalizedEndpoint(url.origin) ? url.origin : null;
}

function safeProtocol(value: string | undefined): ManagedRouterProtocol | null {
  try {
    return normalizeProtocol(value?.trim() || "openai-compatible");
  } catch (cause) {
    if (cause instanceof PlatformRouterConfigValidationError) return null;
    throw cause;
  }
}

function isKnownProtocol(
  value: ManagedRouterProtocol | null,
): value is ManagedRouterProtocol {
  return (
    value === "openai-compatible" ||
    value === "anthropic-messages" ||
    value === "gemini-generate-content"
  );
}

function safeEndpointOrigin(value: string | null): string | null {
  const endpoint = value ? safeNormalizedEndpoint(value) : null;
  return endpoint ? safeUrlOrigin(endpoint) : null;
}

function safeUrlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function endpointForComparison(value: string | null): string | null {
  if (!value) return null;
  return safeNormalizedEndpoint(value) ?? value.trim().replace(/\/+$/, "");
}

function safeNormalizedEndpoint(value: string): string | null {
  try {
    return normalizeEndpoint(value);
  } catch (cause) {
    if (cause instanceof PlatformRouterConfigValidationError) return null;
    throw cause;
  }
}
