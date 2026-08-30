import { normalizePlatformPath } from "./platform-agent-handoff";
import { isUuid } from "./lib/uuid";

export const MEDIA_ATTACHMENT_PROTOCOL = "matchplane.media/v1" as const;
/** Default browser/root relay budget; larger media uses child-owned direct storage. */
export const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** Hard cap for the JSON/base64 relay; larger media should use child-owned direct storage. */
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;

export type MediaAttachmentKind =
  | "image"
  | "document"
  | "video"
  | "audio"
  | "file";

/** Opaque reference returned by a subplatform-owned media adapter. */
export interface MarketplaceAttachment {
  attachment_ref: string;
  kind: MediaAttachmentKind;
  file_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface MediaUploadRequest {
  protocol: typeof MEDIA_ATTACHMENT_PROTOCOL;
  request_id: string;
  scope: {
    tenant_id: string;
    domain_id: string;
    platform_path: string;
  };
  intent_id?: string | null;
  attachment: {
    kind: MediaAttachmentKind;
    file_name: string;
    media_type: string;
    size_bytes: number;
    data_base64: string;
  };
}

export interface MediaUploadResponse {
  protocol: typeof MEDIA_ATTACHMENT_PROTOCOL;
  request_id: string;
  attachment: MarketplaceAttachment;
}

export type MediaParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}$/i;
const MEDIA_KINDS = new Set<MediaAttachmentKind>([
  "image",
  "document",
  "video",
  "audio",
  "file",
]);
const MEDIA_TYPES: RegExp[] = [
  /^image\/(?:avif|gif|heic|heif|jpeg|png|webp)$/i,
  /^application\/(?:json|pdf|zip)$/i,
  /^text\/plain$/i,
  /^audio\/(?:mpeg|mp4|ogg|wav|webm)$/i,
  /^video\/(?:mp4|quicktime|webm)$/i,
];

export function parseMediaUploadRequest(
  value: unknown,
  maximumBytes = DEFAULT_MAX_MEDIA_BYTES,
): MediaParseResult<MediaUploadRequest> {
  try {
    return parseMediaUploadRequestValue(value, maximumBytes);
  } catch {
    return failure("media upload could not be validated");
  }
}

function parseMediaUploadRequestValue(
  value: unknown,
  maximumBytes: number,
): MediaParseResult<MediaUploadRequest> {
  if (!isRecord(value)) return failure("media upload must be a JSON object");
  const unsupported = Object.keys(value).find(
    (key) =>
      !new Set([
        "protocol",
        "request_id",
        "scope",
        "intent_id",
        "attachment",
      ]).has(key),
  );
  if (unsupported)
    return failure(
      `media upload contains an unsupported field: ${unsupported}`,
    );
  if (value.protocol !== MEDIA_ATTACHMENT_PROTOCOL)
    return failure("protocol must be matchplane.media/v1");
  if (!isUuid(value.request_id)) return failure("request_id must be a UUID");

  const scope = value.scope;
  if (!isRecord(scope))
    return failure("scope must contain tenant_id, domain_id and platform_path");
  const unsupportedScope = Object.keys(scope).find(
    (key) => !new Set(["tenant_id", "domain_id", "platform_path"]).has(key),
  );
  if (unsupportedScope)
    return failure(`scope contains an unsupported field: ${unsupportedScope}`);
  if (!isUuid(scope.tenant_id))
    return failure("scope.tenant_id must be a UUID");
  if (!isUuid(scope.domain_id))
    return failure("scope.domain_id must be a UUID");
  const platformPath = normalizePlatformPath(scope.platform_path);
  if (!platformPath || platformPath === "/")
    return failure("scope.platform_path must identify a child platform");

  if (
    value.intent_id !== undefined &&
    value.intent_id !== null &&
    !isUuid(value.intent_id)
  ) {
    return failure("intent_id must be a UUID or null");
  }

  const attachment = value.attachment;
  if (!isRecord(attachment)) return failure("attachment is required");
  const unsupportedAttachment = Object.keys(attachment).find(
    (key) =>
      !new Set([
        "kind",
        "file_name",
        "media_type",
        "size_bytes",
        "data_base64",
      ]).has(key),
  );
  if (unsupportedAttachment)
    return failure(
      `attachment contains an unsupported field: ${unsupportedAttachment}`,
    );
  const kind = attachment.kind;
  const fileName = attachment.file_name;
  const mediaType = attachment.media_type;
  const sizeBytes = attachment.size_bytes;
  const dataBase64 = attachment.data_base64;
  if (!isMediaKind(kind)) return failure("attachment.kind is invalid");
  if (!isSafeFileName(fileName))
    return failure("attachment.file_name is invalid");
  if (
    !isMimeType(mediaType) ||
    !MEDIA_TYPES.some((pattern) => pattern.test(mediaType))
  ) {
    return failure("attachment.media_type is not an allowed media type");
  }
  if (!kindMatchesMediaType(kind, mediaType))
    return failure("attachment.kind does not match media_type");
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > maximumBytes
  ) {
    return failure(
      `attachment.size_bytes must be between 1 and ${maximumBytes} bytes`,
    );
  }
  if (typeof dataBase64 !== "string" || !isValidBase64(dataBase64)) {
    return failure("attachment.data_base64 must be valid base64");
  }
  const decodedBytes = decodedBase64Bytes(dataBase64);
  if (decodedBytes !== sizeBytes)
    return failure("attachment.size_bytes does not match data_base64");

  return {
    ok: true,
    value: {
      protocol: MEDIA_ATTACHMENT_PROTOCOL,
      request_id: value.request_id,
      scope: {
        tenant_id: scope.tenant_id,
        domain_id: scope.domain_id,
        platform_path: platformPath,
      },
      ...(value.intent_id === undefined
        ? {}
        : { intent_id: value.intent_id as string | null }),
      attachment: {
        kind,
        file_name: fileName,
        media_type: mediaType.toLowerCase(),
        size_bytes: sizeBytes,
        data_base64: dataBase64,
      },
    },
  };
}

/** Extract a structured attachment from JSON-RPC or streamable-HTTP MCP content. */
export function extractMcpMediaUploadResult(
  payload: Record<string, unknown>,
): MediaParseResult<Record<string, unknown>> {
  if (isRecord(payload.error))
    return failure("media adapter returned an MCP error");
  const result = isRecord(payload.result) ? payload.result : payload;
  if (result.isError === true)
    return failure("media adapter reported a tool error");
  if (isRecord(result.structuredContent))
    return { ok: true, value: result.structuredContent };
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (
        !isRecord(item) ||
        item.type !== "text" ||
        typeof item.text !== "string"
      )
        continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isRecord(parsed)) return { ok: true, value: parsed };
      } catch {
        // Try the next content block; MCP servers may include human-readable text first.
      }
    }
  }
  return failure("media adapter did not return structured JSON content");
}

export function parseMediaUploadResponse(
  value: unknown,
  requestId: string,
  maximumBytes = MAX_MEDIA_BYTES,
): MediaParseResult<MediaUploadResponse> {
  const extracted =
    isRecord(value) && isRecord(value.attachment) ? value : null;
  if (!extracted)
    return failure("media adapter response must contain attachment");
  const unsupported = Object.keys(extracted).find(
    (key) => !new Set(["protocol", "request_id", "attachment"]).has(key),
  );
  if (unsupported)
    return failure(
      `media adapter response contains an unsupported field: ${unsupported}`,
    );
  if (extracted.protocol !== MEDIA_ATTACHMENT_PROTOCOL)
    return failure("media adapter returned an unsupported protocol");
  if (extracted.request_id !== requestId)
    return failure("media adapter request_id does not match");
  const attachment = parseAttachmentReference(
    extracted.attachment,
    maximumBytes,
  );
  if (!attachment.ok) return attachment;
  return {
    ok: true,
    value: {
      protocol: MEDIA_ATTACHMENT_PROTOCOL,
      request_id: requestId,
      attachment: attachment.value,
    },
  };
}

export function parseAttachmentReference(
  value: unknown,
  maximumBytes = MAX_MEDIA_BYTES,
): MediaParseResult<MarketplaceAttachment> {
  if (!isRecord(value))
    return failure("media adapter attachment must be an object");
  const allowed = new Set([
    "attachment_ref",
    "kind",
    "file_name",
    "media_type",
    "size_bytes",
    "sha256",
    "width",
    "height",
    "duration_ms",
    "metadata",
  ]);
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported)
    return failure(
      `media attachment contains an unsupported field: ${unsupported}`,
    );
  if (
    typeof value.attachment_ref !== "string" ||
    !/^media:\/\/[a-z0-9][a-z0-9._:/-]{1,511}$/i.test(value.attachment_ref)
  )
    return failure("attachment_ref must be an opaque media:// reference");
  if (
    !isMediaKind(value.kind) ||
    !isSafeFileName(value.file_name) ||
    !isMimeType(value.media_type)
  )
    return failure("media attachment identity is invalid");
  const kind = value.kind;
  const fileName = value.file_name;
  const mediaType = value.media_type;
  const sizeBytes = value.size_bytes;
  if (!kindMatchesMediaType(kind, mediaType))
    return failure("media attachment kind does not match media_type");
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > maximumBytes
  )
    return failure("media attachment size is invalid");
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256))
    return failure("media attachment sha256 is invalid");
  for (const field of ["width", "height", "duration_ms"] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) ||
        (value[field] as number) < 0 ||
        (value[field] as number) > 2_000_000_000)
    )
      return failure(`media attachment ${field} is invalid`);
  }
  if (
    value.metadata !== undefined &&
    (!isRecord(value.metadata) || jsonBytes(value.metadata) > 16 * 1024)
  )
    return failure("media attachment metadata is invalid");
  return {
    ok: true,
    value: {
      attachment_ref: value.attachment_ref,
      kind,
      file_name: fileName,
      media_type: mediaType.toLowerCase(),
      size_bytes: sizeBytes,
      sha256: value.sha256.toLowerCase(),
      ...(value.width === undefined ? {} : { width: value.width as number }),
      ...(value.height === undefined ? {} : { height: value.height as number }),
      ...(value.duration_ms === undefined
        ? {}
        : { duration_ms: value.duration_ms as number }),
      ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
    },
  };
}

export function inferMediaKind(mediaType: string): MediaAttachmentKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (
    mediaType === "application/pdf" ||
    mediaType === "application/json" ||
    mediaType === "text/plain"
  )
    return "document";
  return "file";
}

function kindMatchesMediaType(
  kind: MediaAttachmentKind,
  mediaType: string,
): boolean {
  if (kind === "file") return true;
  if (kind === "image") return mediaType.startsWith("image/");
  if (kind === "video") return mediaType.startsWith("video/");
  if (kind === "audio") return mediaType.startsWith("audio/");
  return (
    mediaType === "application/pdf" ||
    mediaType === "application/json" ||
    mediaType === "text/plain"
  );
}

function isMediaKind(value: unknown): value is MediaAttachmentKind {
  return (
    typeof value === "string" && MEDIA_KINDS.has(value as MediaAttachmentKind)
  );
}

function isMimeType(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 255 && MIME_PATTERN.test(value)
  );
}

function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !/[\\/\u0000-\u001f\u007f]/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isAlphabet) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure<T>(error: string): MediaParseResult<T> {
  return { ok: false, error };
}
