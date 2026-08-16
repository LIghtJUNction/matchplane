import { createHash } from "node:crypto";

export const AGENT_PARTY_ROLES = ["buyer", "seller"] as const;
export type AgentPartyRole = (typeof AGENT_PARTY_ROLES)[number];
export type AgentKeyRole = AgentPartyRole | "both";
export const AGENT_PARTY_SIDES = ["demand", "supply"] as const;
export type AgentPartySide = (typeof AGENT_PARTY_SIDES)[number];
export type AgentKeySide = AgentPartySide | "both";

/**
 * Validate the small request accepted by the machine-agent capability exchange.
 * The route intentionally does not accept a caller-selected participant id: the
 * participant is derived from the Better Auth API-key identity on the server.
 */
export interface AgentSessionRequest {
  tenantId?: string;
  domainId?: string;
  platformPath?: string;
  side?: AgentPartySide;
  /** Legacy alias. New integrations should send `side`. */
  role?: AgentPartyRole;
  displayName?: string;
}

export function parseAgentSessionRequest(value: unknown):
  | { ok: true; value: Required<Pick<AgentSessionRequest, "tenantId" | "domainId" | "platformPath" | "role" | "side">> & { displayName: string } }
  | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "agent session must be a JSON object" };
  const unknownKey = Object.keys(value).find((key) => !["tenantId", "domainId", "platformPath", "side", "role", "displayName"].includes(key));
  if (unknownKey) return { ok: false, error: `agent session contains an unsupported field: ${unknownKey}` };
  if (!isUuid(value.tenantId)) return { ok: false, error: "tenantId must be a UUID" };
  if (!isUuid(value.domainId)) return { ok: false, error: "domainId must be a UUID" };
  if (!isPlatformPath(value.platformPath)) {
    return { ok: false, error: "platformPath must be a canonical platform path" };
  }
  const sideFromRole = isAgentPartyRole(value.role)
    ? (value.role === "buyer" ? "demand" : "supply")
    : null;
  const side = isAgentPartySide(value.side) ? value.side : sideFromRole;
  if (!side) return { ok: false, error: "side must be demand or supply" };
  if (sideFromRole && sideFromRole !== side) {
    return { ok: false, error: "side and deprecated role must describe the same capability" };
  }
  const role = isAgentPartyRole(value.role) ? value.role : side === "demand" ? "buyer" : "seller";
  const displayName = typeof value.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim()
    : "MatchPlane external Agent";
  if (displayName.length > 200 || [...displayName].some((character) => character.codePointAt(0)! < 0x20)) {
    return { ok: false, error: "displayName must contain at most 200 printable characters" };
  }
  return {
    ok: true,
    value: {
      tenantId: value.tenantId,
      domainId: value.domainId,
      platformPath: value.platformPath,
      side,
      role,
      displayName,
    },
  };
}

export function isAgentPartyRole(value: unknown): value is AgentPartyRole {
  return value === "buyer" || value === "seller";
}

export function isAgentPartySide(value: unknown): value is AgentPartySide {
  return value === "demand" || value === "supply";
}

export function isAgentKeyRole(value: unknown): value is AgentKeyRole {
  return isAgentPartyRole(value) || value === "both";
}

/** Neutral API-key capability metadata. `agentRole` remains a compatibility alias only. */
export function isAgentKeySide(value: unknown): value is AgentKeySide {
  return isAgentPartySide(value) || value === "both";
}

export function keyCanActAsNeutralSide(role: AgentKeySide, requested: AgentPartySide): boolean {
  return role === "both" || role === requested;
}

export function keyCanActAs(role: AgentKeyRole, requested: AgentPartyRole): boolean {
  return role === "both" || role === requested;
}

export function keyCanActAsSide(role: AgentKeyRole, requested: AgentPartySide): boolean {
  return keyCanActAs(role, requested === "demand" ? "buyer" : "seller");
}

/** Derive a stable UUID for a machine principal without exposing the API-key id to the gateway. */
export function stableAgentPrincipalId(apiKeyId: string, tenantId: string): string {
  const digest = createHash("sha256")
    .update(`matchplane:agent-party:v1:${apiKeyId}:${tenantId}`)
    .digest();
  // UUID version 5 + RFC 4122 variant. A hash-derived id is deterministic but not reversible.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isPlatformPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 512
    && (value === "/" || /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value));
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
