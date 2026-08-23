import { createHash } from "node:crypto";

export const CATALOG_PROJECTION_PROTOCOL = "matchplane.catalog/v2" as const;

export type CatalogOfferStatus =
  | "draft"
  | "active"
  | "reserved"
  | "sold"
  | "withdrawn"
  | "expired";

export interface CanonicalCatalogOffer {
  offerId: string;
  externalKey: string;
  displayName: string;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
  status: CatalogOfferStatus;
  canonicalVersion: number;
}

export interface CatalogProjectionArguments extends Record<string, unknown> {
  protocol: typeof CATALOG_PROJECTION_PROTOCOL;
  request_id: string;
  canonical_version: number;
  projection_digest: string;
  scope: {
    tenant_id: string;
    domain_id: string;
    platform_path: string;
  };
  offer: {
    offer_id: string;
    external_key: string;
    display_name: string;
    attributes: Record<string, unknown>;
    terms: Record<string, unknown>;
    status: CatalogOfferStatus;
    attachments: string[];
  };
}

export type CatalogProjectionAck =
  | {
      ok: true;
      superseded: boolean;
      appliedVersion: number;
      applied: boolean;
    }
  | { ok: false; error: string };

/** Build a deterministic, version-bound projection from a freshly read canonical offer. */
export function buildCatalogProjectionArguments(input: {
  requestId: string;
  tenantId: string;
  domainId: string;
  platformPath: string;
  offer: CanonicalCatalogOffer;
}): CatalogProjectionArguments {
  if (
    !Number.isSafeInteger(input.offer.canonicalVersion) ||
    input.offer.canonicalVersion < 1
  ) {
    throw new Error("canonical offer version must be a positive safe integer");
  }
  const scope = {
    tenant_id: input.tenantId,
    domain_id: input.domainId,
    platform_path: input.platformPath,
  };
  const offer = {
    offer_id: input.offer.offerId,
    external_key: input.offer.externalKey,
    display_name: input.offer.displayName,
    attributes: input.offer.attributes,
    terms: input.offer.terms,
    status: input.offer.status,
    attachments: catalogAttachments(input.offer.attributes),
  };
  const projectionDigest = createHash("sha256")
    .update(
      stableJson({
        canonical_version: input.offer.canonicalVersion,
        scope,
        offer,
      }),
    )
    .digest("hex");
  return {
    protocol: CATALOG_PROJECTION_PROTOCOL,
    request_id: input.requestId,
    canonical_version: input.offer.canonicalVersion,
    projection_digest: projectionDigest,
    scope,
    offer,
  };
}

/** Validate the business ACK inside an MCP tools/call JSON-RPC response. */
export function parseCatalogProjectionAck(
  payload: Record<string, unknown>,
  expected: CatalogProjectionArguments,
): CatalogProjectionAck {
  const result = objectValue(payload.result);
  const ack = objectValue(result?.structuredContent);
  if (!ack) return failure("child response has no structured catalog ACK");
  if (ack.protocol !== CATALOG_PROJECTION_PROTOCOL)
    return failure("child catalog ACK protocol mismatch");
  if (ack.request_id !== expected.request_id)
    return failure("child catalog ACK request mismatch");
  if (!sameScope(ack.scope, expected.scope))
    return failure("child catalog ACK scope mismatch");
  if (ack.offer_id !== expected.offer.offer_id)
    return failure("child catalog ACK offer mismatch");
  if (ack.canonical_version !== expected.canonical_version) {
    return failure("child catalog ACK did not echo the requested version");
  }
  const appliedVersion = positiveSafeInteger(ack.applied_version);
  if (!appliedVersion || appliedVersion < expected.canonical_version) {
    return failure("child catalog ACK applied version is stale or invalid");
  }
  if (typeof ack.applied !== "boolean" || typeof ack.indexed !== "boolean") {
    return failure("child catalog ACK application flags are invalid");
  }
  if (appliedVersion > expected.canonical_version) {
    return { ok: true, superseded: true, appliedVersion, applied: ack.applied };
  }
  if (ack.projection_digest !== expected.projection_digest) {
    return failure("child catalog ACK projection digest mismatch");
  }
  if (ack.status !== expected.offer.status)
    return failure("child catalog ACK status mismatch");
  if (ack.indexed !== (expected.offer.status === "active")) {
    return failure(
      "child catalog ACK indexed flag contradicts canonical status",
    );
  }
  return { ok: true, superseded: false, appliedVersion, applied: ack.applied };
}

function catalogAttachments(attributes: Record<string, unknown>): string[] {
  const attachments = attributes.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((value) => {
    const attachment = objectValue(value);
    return typeof attachment?.attachment_ref === "string"
      ? [attachment.attachment_ref]
      : [];
  });
}

function sameScope(
  value: unknown,
  expected: CatalogProjectionArguments["scope"],
): boolean {
  const scope = objectValue(value);
  return Boolean(
    scope &&
      scope.tenant_id === expected.tenant_id &&
      scope.domain_id === expected.domain_id &&
      scope.platform_path === expected.platform_path,
  );
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("catalog projection contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = objectValue(value);
  if (!record)
    throw new Error("catalog projection contains an unsupported JSON value");
  return `{${Object.keys(record)
    .sort(compareCanonicalKeys)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function failure(error: string): CatalogProjectionAck {
  return { ok: false, error };
}
