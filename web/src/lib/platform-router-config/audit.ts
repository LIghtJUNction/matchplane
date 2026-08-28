import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  boundedAuditText,
  boundedText,
  isRecord,
  normalizeEndpoint,
  type PlatformRouterAuditEvent,
} from "./contract";

export const PLATFORM_ROUTER_AUDIT_FILE = "platform-router.audit.jsonl";
const SECRET_ROOT = "/etc/matchplane/secrets/root-email";
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

interface PlatformRouterAuditAppendOptions {
  root?: string;
  nextId?: () => string;
  now?: () => Date;
  write?: typeof writeSync;
  fsync?: typeof fsyncSync;
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

export function appendPlatformRouterAudit(
  event: PlatformRouterAuditEvent,
  options: PlatformRouterAuditAppendOptions = {},
): void {
  const record = buildPlatformRouterAuditRecord(
    event,
    options.now?.() ?? new Date(),
    options.nextId ?? randomUUID,
  );
  const auditPath = path.join(options.root ?? SECRET_ROOT, PLATFORM_ROUTER_AUDIT_FILE);
  const errors: Error[] = [];
  let descriptor: number | null = null;
  let existed = false;
  try {
    try {
      const stat = lstatSync(auditPath);
      existed = true;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("AI 配置审计路径不是普通文件");
      }
    } catch (cause) {
      if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
    }
    descriptor = openSync(
      auditPath,
      fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o640,
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("AI 配置审计路径不是普通文件");
    }
    fchmodSync(descriptor, 0o640);
    writeAll(descriptor, Buffer.from(`${JSON.stringify(record)}\n`), options.write);
    (options.fsync ?? fsyncSync)(descriptor);
    if (!existed) fsyncDirectory(path.dirname(auditPath), options.fsync);
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

function writeAll(
  descriptor: number,
  bytes: Buffer,
  writer: typeof writeSync = writeSync,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (written <= 0) throw new Error("AI 配置审计写入返回零字节");
    offset += written;
  }
}

function fsyncDirectory(directory: string, fsync = fsyncSync): void {
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    fsync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === code
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
