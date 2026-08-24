import {
  M0_REQUIRED_ROUTER_ENDPOINT,
  M0_REQUIRED_ROUTER_MODEL,
  M0_REQUIRED_ROUTER_PROTOCOL,
  normalizeEndpoint,
  normalizeProtocol,
  PlatformRouterConfigValidationError,
  type ManagedPlatformRouterConfig,
  type ManagedRouterProtocol,
  type PlatformRouterEffectiveStatus,
} from "./contract";
import { getManagedPlatformRouterConfig } from "./lifecycle";

export interface EnvironmentProviderStatus {
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  credentialConfigured: boolean;
  present: boolean;
  configured: boolean;
}

interface SelectedProviderStatus {
  source: PlatformRouterEffectiveStatus["source"];
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  enabled: boolean;
  credentialConfigured: boolean;
}

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

function unreadableManagedPlatformRouterEffectiveStatus(
  environment: EnvironmentProviderStatus,
): PlatformRouterEffectiveStatus {
  return {
    ready: false,
    code: "upstream_configuration",
    preferredHttpStatus: 451,
    source: "managed",
    managedOverridesEnvironment: environment.present,
    conflicts: { endpoint: false, model: false, protocol: false },
    endpointOrigin: null,
    model: null,
    protocol: null,
    enabled: false,
    credentialConfigured: false,
    endpointMatchesRequired: false,
    modelMatchesRequired: false,
    protocolMatchesRequired: false,
    requiredEndpoint: M0_REQUIRED_ROUTER_ENDPOINT,
    requiredModel: M0_REQUIRED_ROUTER_MODEL,
    issues: ["managed_configuration_unreadable"],
  };
}

export function platformRouterEffectiveStatusFrom(
  managed: ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
): PlatformRouterEffectiveStatus {
  const selected = selectEffectiveProvider(managed, environment);
  const issues = platformRouterPolicyIssues(selected);
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
    endpointMatchesRequired:
      endpointForComparison(selected.endpoint) === M0_REQUIRED_ROUTER_ENDPOINT,
    modelMatchesRequired: selected.model === M0_REQUIRED_ROUTER_MODEL,
    protocolMatchesRequired:
      selected.protocol === M0_REQUIRED_ROUTER_PROTOCOL,
    requiredEndpoint: M0_REQUIRED_ROUTER_ENDPOINT,
    requiredModel: M0_REQUIRED_ROUTER_MODEL,
    issues,
  };
}

export function platformRouterPolicyIssues(
  value: Pick<
    PlatformRouterEffectiveStatus,
    "model" | "protocol" | "enabled" | "credentialConfigured"
  > & {
    source?: PlatformRouterEffectiveStatus["source"];
    endpoint?: string | null;
    endpointOrigin?: string | null;
  },
): string[] {
  const endpoint = value.endpoint ?? value.endpointOrigin ?? null;
  const issues: string[] = [];
  if (value.source === "unconfigured") issues.push("provider_not_configured");
  if (!value.enabled) issues.push("provider_not_enabled");
  if (!value.credentialConfigured) issues.push("credential_not_configured");
  if (!isSafeHttpsEndpoint(endpoint)) issues.push("endpoint_invalid");
  if (endpointForComparison(endpoint) !== M0_REQUIRED_ROUTER_ENDPOINT) {
    issues.push("endpoint_mismatch");
  }
  if (value.model !== M0_REQUIRED_ROUTER_MODEL) issues.push("model_mismatch");
  if (value.protocol !== M0_REQUIRED_ROUTER_PROTOCOL) {
    issues.push("protocol_mismatch");
  }
  return [...new Set(issues)];
}

export function readEnvironmentProviderStatus(
  environment: NodeJS.ProcessEnv = process.env,
): EnvironmentProviderStatus {
  const endpoint = environment.MATCHPLANE_ROUTER_AI_URL?.trim() || null;
  const model = environment.MATCHPLANE_ROUTER_AI_MODEL?.trim() || null;
  const credentialConfigured = Boolean(
    environment.MATCHPLANE_ROUTER_AI_KEY?.trim(),
  );
  const protocol = safeProtocol(environment.MATCHPLANE_ROUTER_AI_PROTOCOL);
  const present = Boolean(endpoint || model || credentialConfigured);
  return {
    endpoint,
    model,
    credentialConfigured,
    protocol,
    present,
    configured: Boolean(
      endpoint &&
        model &&
        credentialConfigured &&
        protocol &&
        isSafeHttpsEndpoint(endpoint),
    ),
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
  if (environment.configured) {
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

function safeProtocol(value: string | undefined): ManagedRouterProtocol | null {
  try {
    return normalizeProtocol(value?.trim() || M0_REQUIRED_ROUTER_PROTOCOL);
  } catch (cause) {
    if (cause instanceof PlatformRouterConfigValidationError) return null;
    throw cause;
  }
}

function isSafeHttpsEndpoint(value: string | null): boolean {
  return value !== null && safeNormalizedEndpoint(value) !== null;
}

function safeEndpointOrigin(value: string | null): string | null {
  const endpoint = value ? safeNormalizedEndpoint(value) : null;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
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
