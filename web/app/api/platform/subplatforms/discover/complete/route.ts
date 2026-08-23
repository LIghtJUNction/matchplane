import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../../src/lib/body-limit";
import { hasValidConfiguredSubplatformBuilderToken } from "../../../../../../src/subplatform-builder";
import { isUuid } from "../../../../../../src/lib/uuid";

export const runtime = "nodejs";

/** Persist builder-discovered manifest metadata; registration remains an operator/API action. */
export async function POST(request: Request): Promise<Response> {
  if (!(await hasValidConfiguredSubplatformBuilderToken(request.headers.get("x-matchplane-builder-token")))) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }
  let input: CompleteRequest;
  try {
    input = await parseBody(request);
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "源码发现回调过大" : "请求 JSON 无效", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const intakeId = isUuid(input.intakeId) ? input.intakeId : null;
  const leaseId = isUuid(input.leaseId) ? input.leaseId : null;
  if (!intakeId || !leaseId) return jsonError("intakeId/leaseId 必须是 UUID", 400);
  const sourceDigest = typeof input.sourceDigest === "string" ? input.sourceDigest.toLowerCase() : "";
  const pinnedRevision = typeof input.pinnedRevision === "string" ? input.pinnedRevision.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/i.test(sourceDigest)) return jsonError("sourceDigest 必须是 SHA-256", 400);
  // Git discovery returns the resolved 40-character commit. Archive discovery has no
  // commit, so it pins the immutable 64-character upload digest instead. Both values are
  // persisted as the registration's immutable revision and are never user-supplied code.
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pinnedRevision)) {
    return jsonError("pinnedRevision 必须是完整 commit SHA 或压缩包 SHA-256", 400);
  }
  if (!isRecord(input.manifest)) return jsonError("manifest 必须是 JSON 对象", 400);
  const serialized = canonicalJson(input.manifest);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) return jsonError("manifest 过大", 400);
  const manifestDigest = createHash("sha256").update(serialized).digest("hex");
  const suppliedManifestDigest = typeof input.manifestDigest === "string" ? input.manifestDigest.toLowerCase() : "";
  if (suppliedManifestDigest && suppliedManifestDigest !== manifestDigest) return jsonError("manifestDigest 不匹配", 409);
  const result = await authDatabase.query(
    `UPDATE subplatform_source_intakes
        SET source_digest = decode($3, 'hex'), pinned_revision = $4,
            manifest = $5::jsonb, manifest_digest = decode($6, 'hex'), state = 'ready',
            discover_lease_id = NULL, discover_started_at = NULL, error = NULL, updated_at = clock_timestamp()
      WHERE id = $1::uuid AND discover_lease_id = $2::uuid AND state = 'discovering'
      RETURNING id::text AS "intakeId", state, source_locator AS "sourceLocator",
                encode(source_digest, 'hex') AS "sourceDigest", pinned_revision AS "pinnedRevision",
                manifest, encode(manifest_digest, 'hex') AS "manifestDigest"`,
    [intakeId, leaseId, sourceDigest, pinnedRevision, JSON.stringify(input.manifest), manifestDigest],
  );
  if (result.rowCount !== 1) return jsonError("源码导入任务不存在、已完成或 lease 已失效", 409);
  return NextResponse.json(result.rows[0], { headers: { "cache-control": "no-store" } });
}

interface CompleteRequest { intakeId?: unknown; leaseId?: unknown; sourceDigest?: unknown; pinnedRevision?: unknown; manifestDigest?: unknown; manifest?: unknown }
async function parseBody(request: Request): Promise<CompleteRequest> {
  try {
    const value = await readJsonBody<unknown>(request, 128 * 1024);
    return isRecord(value) ? value as CompleteRequest : {};
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return {};
  }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function jsonError(error: string, status: number): Response { return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } }); }
