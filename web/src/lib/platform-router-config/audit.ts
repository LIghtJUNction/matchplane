import { randomUUID } from "node:crypto";
import {
  boundedAuditText,
  boundedText,
  isRecord,
  normalizeEndpoint,
  type PlatformRouterAuditEvent,
} from "./contract";

export const PLATFORM_ROUTER_AUDIT_FILE = "platform-router.audit.jsonl";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PlatformRouterAuditRecord {
  eventId: string;
  at: string;
  action: PlatformRouterAuditEvent["action"];
  actor: string;
  requestId: string;
  endpointOrigin: string;
  model: string;
  enabled: boolean;
  keyChanged: boolean;
}

export function buildPlatformRouterAuditRecord(
  event: PlatformRouterAuditEvent,
  now = new Date(),
  nextId: () => string = randomUUID,
): PlatformRouterAuditRecord {
  if (!Number.isFinite(now.getTime())) throw new Error("AI 配置审计时间无效");
  const at = now.toISOString();
  return {
    eventId: normalizeAuditEventId(event.eventId ?? nextId()),
    at,
    action: normalizeAuditAction(event.action),
    actor: boundedAuditText(event.actor, "actor"),
    requestId: boundedAuditText(event.requestId, "request id"),
    endpointOrigin: auditEndpointOrigin(event.endpoint, false),
    model: boundedText(event.model, "模型", 256),
    enabled: Boolean(event.enabled),
    keyChanged: Boolean(event.keyChanged),
  };
}

export function decodePlatformRouterAuditRecord(
  value: unknown,
): PlatformRouterAuditRecord {
  if (
    !isRecord(value) ||
    typeof value.at !== "string" ||
    !isIsoInstant(value.at) ||
    typeof value.actor !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.endpointOrigin !== "string" ||
    typeof value.model !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.keyChanged !== "boolean"
  ) {
    throw new Error("AI 配置审计记录无效");
  }
  const endpoint = auditEndpointOrigin(value.endpointOrigin, true);
  return {
    eventId: normalizeAuditEventId(value.eventId),
    at: value.at,
    action: normalizeAuditAction(value.action),
    actor: boundedAuditText(value.actor, "actor"),
    requestId: boundedAuditText(value.requestId, "request id"),
    endpointOrigin: endpoint,
    model: boundedText(value.model, "模型", 256),
    enabled: value.enabled,
    keyChanged: value.keyChanged,
  };
}

export function normalizeAuditEventId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("AI 配置审计事件 ID 无效");
  }
  return value.toLowerCase();
}

function auditEndpointOrigin(value: unknown, requireOrigin: boolean): string {
  try {
    const endpoint = normalizeEndpoint(value);
    const origin = new URL(endpoint).origin;
    if (requireOrigin && origin !== endpoint) {
      throw new Error("AI 配置审计端点必须为 origin");
    }
    return origin;
  } catch (cause) {
    throw new Error("AI 配置审计端点无效", { cause });
  }
}

function normalizeAuditAction(value: unknown): PlatformRouterAuditEvent["action"] {
  if (value === "stage" || value === "test" || value === "activate") return value;
  throw new Error("AI 配置审计动作无效");
}

function isIsoInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
