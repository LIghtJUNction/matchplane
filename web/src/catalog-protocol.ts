import { normalizePlatformPath } from "./platform-agent-handoff";
import { isUuid } from "./lib/uuid";

export const CATALOG_PROTOCOL = "matchplane.catalog/v1" as const;

export interface CatalogSyncRequest {
  protocol: typeof CATALOG_PROTOCOL;
  requestId: string;
  tenantId: string;
  domainId: string;
  platformPath: string;
  offerId: string;
}

export type CatalogParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The browser submits only the canonical offer id; the server re-reads every field before sync. */
export function parseCatalogSyncRequest(value: unknown): CatalogParseResult<CatalogSyncRequest> {
  if (!isRecord(value)) return failure("catalog sync must be a JSON object");
  const unsupported = Object.keys(value).find((key) => !["protocol", "request_id", "scope", "offer_id"].includes(key));
  if (unsupported) return failure(`catalog sync contains an unsupported field: ${unsupported}`);
  if (value.protocol !== CATALOG_PROTOCOL) return failure("protocol must be matchplane.catalog/v1");
  if (!isUuid(value.request_id)) return failure("request_id must be a UUID");
  const scope = value.scope;
  if (!isRecord(scope)) return failure("scope must contain tenant_id, domain_id and platform_path");
  const scopeUnknown = Object.keys(scope).find((key) => !["tenant_id", "domain_id", "platform_path"].includes(key));
  if (scopeUnknown) return failure(`scope contains an unsupported field: ${scopeUnknown}`);
  if (!isUuid(scope.tenant_id) || !isUuid(scope.domain_id)) return failure("scope tenant_id and domain_id must be UUIDs");
  const platformPath = normalizePlatformPath(scope.platform_path);
  if (!platformPath || platformPath === "/") return failure("scope.platform_path must identify a child platform");
  if (!isUuid(value.offer_id)) return failure("offer_id must be a UUID");
  return {
    ok: true,
    value: {
      protocol: CATALOG_PROTOCOL,
      requestId: value.request_id,
      tenantId: scope.tenant_id,
      domainId: scope.domain_id,
      platformPath,
      offerId: value.offer_id,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure<T>(error: string): CatalogParseResult<T> {
  return { ok: false, error };
}
