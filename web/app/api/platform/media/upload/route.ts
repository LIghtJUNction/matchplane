import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import sharp from "sharp";

import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { executeAuthorizedChildTool } from "../../../../../src/platform-child-tool";
import { isMountedPlatformPath, readActivePlatformScope } from "../../../../../src/platform-mount";
import { authenticatePlatformRequest } from "../../../../../src/platform-request-auth";
import { isProductionEnvironment } from "../../../../../src/lib/runtime";
import {
  DEFAULT_MAX_MEDIA_BYTES,
  MAX_MEDIA_BYTES,
  MEDIA_ATTACHMENT_PROTOCOL,
  extractMcpMediaUploadResult,
  parseMediaUploadRequest,
  parseMediaUploadResponse,
} from "../../../../../src/media-attachment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser/Agent facade for store media. Native hosted stores use the marketplace's bounded local
 * object store; package and external stores keep their own reviewed media adapter.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);

  // Authenticate before accepting a potentially large base64 envelope. A mere API-key header is
  // not sufficient: `authenticatePlatformRequest` verifies the key and its media permission.
  const actor = await authenticatePlatformRequest(request, { media: ["upload"] }, { allowSession: true });
  if (!actor) return jsonError("Better Auth session or media API key is required", 401);

  const maximumBytes = configuredMaximumBytes();
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, jsonBodyLimit(maximumBytes));
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "附件请求超过当前部署的大小上限" : "附件请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const parsed = parseMediaUploadRequest(body, maximumBytes);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const input = parsed.value;

  if (!(await isMountedPlatformPath(input.scope.platform_path))) return jsonError("当前平台路径尚未激活", 404);

  const hostedStore = await readHostedStore(input.scope);
  if (hostedStore) {
    if (input.attachment.kind !== "image") return jsonError("托管店铺当前只接受商品图片", 400);
    if (input.attachment.size_bytes > DEFAULT_MAX_MEDIA_BYTES) return jsonError("单张商品图片不能超过 25 MiB", 413);
    if (actor.access === "session") {
      const member = await authDatabase.query(
        `SELECT 1 FROM "member"
          WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid
            AND role = ANY($3::text[])
          LIMIT 1`,
        [hostedStore.organizationId, actor.subject, ["owner", "admin", "subplatform_admin"]],
      );
      if (!actor.isRootAdministrator && member.rowCount !== 1) return jsonError("只有店主或店铺运营可以上传商品图片", 403);
    } else if (actor.organizationId !== hostedStore.organizationId) {
      return jsonError("API key 不属于当前店铺", 403);
    }
    try {
      const attachment = await persistHostedImage({
        actorSubject: actor.subject,
        store: hostedStore,
        attachment: input.attachment,
      });
      return NextResponse.json({
        protocol: MEDIA_ATTACHMENT_PROTOCOL,
        request_id: input.request_id,
        attachment,
      }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof HostedMediaQuotaExceeded) return jsonError(error.message, 413);
      if (error instanceof HostedMediaInvalidImage) return jsonError(error.message, 400);
      console.error("hosted store image persistence failed", error);
      return jsonError("商品图片保存失败，请稍后重试", 500);
    }
  }

  if (actor.access === "session") {
    const scope = await readActivePlatformScope(input.scope.platform_path);
    if (isProductionEnvironment() && (!scope || scope.tenantId !== input.scope.tenant_id || scope.domainId !== input.scope.domain_id)) {
      return jsonError("附件作用域与 active 子平台不匹配", 403);
    }
    if (scope) {
      const member = await authDatabase.query(
        `SELECT 1 FROM "member"
          WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid
          LIMIT 1`,
        [scope.organizationId, actor.subject],
      );
      if (member.rowCount !== 1) return jsonError("请先加入当前子平台", 403);
    }
  }

  const execution = await executeAuthorizedChildTool({
    actor,
    platformPath: input.scope.platform_path,
    toolName: "media.upload",
    arguments: input as unknown as Record<string, unknown>,
    requestId: input.request_id,
    tenantId: input.scope.tenant_id,
    domainId: input.scope.domain_id,
  });
  if (!execution.ok) return jsonError(readError(execution.payload) ?? "子平台媒体适配器暂时不可用", execution.status >= 400 ? execution.status : 502);

  const extracted = extractMcpMediaUploadResult(execution.payload);
  if (!extracted.ok) return jsonError(extracted.error, 502);
  const response = parseMediaUploadResponse(extracted.value, input.request_id, maximumBytes);
  if (!response.ok) return jsonError(response.error, 502);
  return NextResponse.json(response.value, {
    headers: { "cache-control": "no-store" },
  });
}

interface HostedStoreScope {
  id: string;
  tenantId: string;
  organizationId: string;
}

async function readHostedStore(scope: { tenant_id: string; domain_id: string; platform_path: string }): Promise<HostedStoreScope | null> {
  const result = await authDatabase.query<HostedStoreScope>(
    `SELECT store.id::text,
            store.tenant_id::text AS "tenantId",
            store.organization_id::text AS "organizationId"
       FROM stores store
       JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id
       JOIN domains domain
         ON domain.tenant_id = store.tenant_id AND domain.id = store.domain_id AND domain.status = 'active'
      WHERE store.tenant_id = $1::uuid
        AND store.domain_id = $2::uuid
        AND alias.path = $3
        AND store.integration_kind = 'hosted'
        AND store.status = 'active'
      LIMIT 1`,
    [scope.tenant_id, scope.domain_id, scope.platform_path],
  );
  return result.rows[0] ?? null;
}

async function persistHostedImage(input: {
  actorSubject: string;
  store: HostedStoreScope;
  attachment: {
    file_name: string;
    media_type: string;
    size_bytes: number;
    data_base64: string;
  };
}): Promise<{
  attachment_ref: string;
  kind: "image";
  file_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  width: number;
  height: number;
  metadata: { public_url: string };
}> {
  const storageRoot = await hostedMediaRoot();
  if (!storageRoot) throw new Error("MATCHPLANE_HOSTED_MEDIA_ROOT must be an absolute path");
  const normalized = await normalizeHostedImage(
    Buffer.from(input.attachment.data_base64, "base64"),
    input.attachment.file_name,
  );
  const mediaId = randomUUID();
  const storageKey = `${mediaId}.webp`;
  const storeDirectory = path.join(/* turbopackIgnore: true */ storageRoot, input.store.tenantId, input.store.id);
  await mkdir(storeDirectory, { recursive: true, mode: 0o750 });
  const canonicalStoreDirectory = await realpath(/* turbopackIgnore: true */ storeDirectory);
  if (!canonicalStoreDirectory.startsWith(`${storageRoot}${path.sep}`)) throw new Error("hosted media directory escaped its root");
  const filePath = path.join(/* turbopackIgnore: true */ canonicalStoreDirectory, storageKey);
  const bytes = normalized.bytes;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    await client.query(
      `SELECT id FROM stores WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
      [input.store.tenantId, input.store.id],
    );
    const usage = await client.query<{ bytes: string }>(
      `SELECT COALESCE(sum(size_bytes), 0)::text AS bytes
         FROM hosted_store_media
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status IN ('pending', 'published')`,
      [input.store.tenantId, input.store.id],
    );
    if (BigInt(usage.rows[0]?.bytes ?? "0") + BigInt(bytes.byteLength) > 1024n * 1024n * 1024n) {
      throw new HostedMediaQuotaExceeded("当前店铺的图片空间已达到 1 GiB 上限");
    }
    await client.query(
      `INSERT INTO hosted_store_media
        (id, tenant_id, store_id, uploader_subject, storage_key, file_name, media_type, size_bytes, sha256)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, decode($9, 'hex'))`,
      [mediaId, input.store.tenantId, input.store.id, input.actorSubject, storageKey, normalized.fileName, "image/webp", bytes.byteLength, sha256],
    );
    const handle = await open(/* turbopackIgnore: true */ filePath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }

  return {
    attachment_ref: `media://hosted/${mediaId}`,
    kind: "image",
    file_name: normalized.fileName,
    media_type: "image/webp",
    size_bytes: bytes.byteLength,
    sha256,
    width: normalized.width,
    height: normalized.height,
    metadata: { public_url: `/api/store-media/${mediaId}` },
  };
}

async function hostedMediaRoot(): Promise<string | null> {
  const configured = process.env.MATCHPLANE_HOSTED_MEDIA_ROOT?.trim()
    || (isProductionEnvironment() ? "" : "/tmp/matchplane-hosted-media");
  if (!configured || !path.isAbsolute(configured)) return null;
  await mkdir(configured, { recursive: true, mode: 0o750 });
  return realpath(configured);
}

class HostedMediaQuotaExceeded extends Error {}
class HostedMediaInvalidImage extends Error {}

async function normalizeHostedImage(bytes: Buffer, originalName: string): Promise<{
  bytes: Buffer;
  fileName: string;
  width: number;
  height: number;
}> {
  try {
    const pipeline = sharp(bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new Error("unsupported image dimensions");
    }
    const converted = await pipeline
      .rotate()
      .resize({ width: 4_000, height: 4_000, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 88, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!converted.data.byteLength || converted.data.byteLength > DEFAULT_MAX_MEDIA_BYTES) {
      throw new Error("normalized image exceeds limit");
    }
    const baseName = originalName.replace(/\.[^.]+$/, "").trim().slice(0, 240) || "product";
    return {
      bytes: converted.data,
      fileName: `${baseName}.webp`,
      width: converted.info.width,
      height: converted.info.height,
    };
  } catch {
    throw new HostedMediaInvalidImage("图片无法安全解码，请上传有效的 JPG、PNG、WebP、AVIF、HEIF 或 GIF 文件");
  }
}

function configuredMaximumBytes(): number {
  const raw = process.env.MATCHPLANE_MEDIA_MAX_BYTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_MEDIA_BYTES;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_MAX_MEDIA_BYTES;
  return Math.min(parsed, MAX_MEDIA_BYTES);
}

function jsonBodyLimit(maximumBytes: number): number {
  // Base64 adds up to one third overhead; the envelope contributes a bounded amount of metadata.
  return Math.ceil(maximumBytes * 4 / 3) + 128 * 1024;
}

function readError(payload: Record<string, unknown>): string | null {
  return typeof payload.error === "string" && payload.error.length <= 500 ? payload.error : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
