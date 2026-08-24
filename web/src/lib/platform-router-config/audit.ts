import {
  closeSync,
  constants as fsConstants,
  openSync,
  writeSync,
} from "node:fs";
import {
  boundedAuditText,
  boundedText,
  normalizeEndpoint,
  type PlatformRouterAuditEvent,
} from "./contract";

const AUDIT_PATH =
  "/etc/matchplane/secrets/root-email/platform-router.audit.jsonl";

export interface PlatformRouterAuditRecord {
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
): PlatformRouterAuditRecord {
  return {
    at: now.toISOString(),
    action: event.action,
    actor: boundedAuditText(event.actor, "actor"),
    requestId: boundedAuditText(event.requestId, "request id"),
    endpointOrigin: new URL(normalizeEndpoint(event.endpoint)).origin,
    model: boundedText(event.model, "模型", 256),
    enabled: Boolean(event.enabled),
    keyChanged: Boolean(event.keyChanged),
  };
}

export function appendPlatformRouterAudit(
  event: PlatformRouterAuditEvent,
): void {
  const record = buildPlatformRouterAuditRecord(event);
  const errors: Error[] = [];
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      AUDIT_PATH,
      fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o640,
    );
    writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8");
  } catch (cause) {
    errors.push(asError(cause));
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (cause) {
        errors.push(asError(cause));
      }
    }
  }
  if (errors.length > 0) {
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors);
    throw new Error("AI 配置审计写入失败", { cause });
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
