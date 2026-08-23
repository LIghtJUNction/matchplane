import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import { hasValidConfiguredSubplatformBuilderToken } from "../../../../../src/subplatform-builder";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { isUuid } from "../../../../../src/lib/uuid";

export const runtime = "nodejs";

/**
 * Internal callback for the isolated package builder. A browser/admin session
 * cannot manufacture a build digest; only the builder secret may attach the
 * digest that activation later pins.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await hasValidConfiguredSubplatformBuilderToken(request.headers.get("x-matchplane-builder-token")))) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }

  let input: BuilderRequest;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object required");
    input = value as BuilderRequest;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "构建回调请求过大" : "请求必须是有效 JSON" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!input.registrationId || !isUuid(input.registrationId)) {
    return NextResponse.json({ error: "registrationId must be a UUID" }, { status: 400 });
  }
  if (!input.leaseId || !isUuid(input.leaseId)) {
    return NextResponse.json({ error: "leaseId must be a UUID claimed by the builder" }, { status: 400 });
  }
  if (!input.buildDigest || !/^[0-9a-f]{64}$/i.test(input.buildDigest)) {
    return NextResponse.json({ error: "buildDigest must be a SHA-256 digest" }, { status: 400 });
  }
  const artifactError = validateArtifactPath(input.artifactPath, input.artifactEntry);
  if (artifactError) return NextResponse.json({ error: artifactError }, { status: 400 });

  const result = await authDatabase.query(
    `UPDATE subplatform_registrations
        SET build_digest = decode($2, 'hex'),
            artifact_locator = COALESCE($3, artifact_locator),
            artifact_entry = COALESCE($4, artifact_entry),
            state = CASE WHEN state IN ('validated', 'building') THEN 'ready' ELSE state END,
            build_lease_id = NULL,
            build_started_at = NULL,
            build_error = NULL,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND state IN ('validated', 'building', 'ready')
        AND build_lease_id = $5::uuid
        AND (build_digest IS NULL OR build_digest = decode($2, 'hex'))
        AND ($6::text IS NULL OR encode(source_digest, 'hex') = lower($6))
        AND ($7::text IS NULL OR encode(manifest_digest, 'hex') = lower($7))
        AND (artifact_locator IS NULL OR $3::text IS NULL OR artifact_locator = $3::text)
        AND ($4::text IS NULL OR artifact_entry = $4::text OR artifact_locator IS NULL)
      RETURNING id,
                state,
                encode(build_digest, 'hex') AS "buildDigest",
                artifact_locator AS "artifactLocator",
                artifact_entry AS "artifactEntry",
                tenant_id AS "tenantId",
                domain_id AS "domainId",
                slug,
                version`,
    [
      input.registrationId,
      input.buildDigest.toLowerCase(),
      input.artifactPath ?? null,
      input.artifactEntry ?? null,
      input.leaseId,
      input.sourceDigest?.toLowerCase() ?? null,
      input.manifestDigest?.toLowerCase() ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    const existing = await authDatabase.query(
      `SELECT state, encode(build_digest, 'hex') AS "buildDigest",
              encode(source_digest, 'hex') AS "sourceDigest",
              encode(manifest_digest, 'hex') AS "manifestDigest",
              build_lease_id AS "leaseId",
              artifact_locator AS "artifactLocator", artifact_entry AS "artifactEntry"
         FROM subplatform_registrations
        WHERE id = $1::uuid
        LIMIT 1`,
      [input.registrationId],
    );
    const row = existing.rows[0] as {
      state?: string;
      buildDigest?: string | null;
      sourceDigest?: string | null;
      manifestDigest?: string | null;
      leaseId?: string | null;
      artifactLocator?: string | null;
      artifactEntry?: string | null;
    } | undefined;
    if (!row) return NextResponse.json({ error: "子平台注册记录不存在" }, { status: 404 });
    if (row.buildDigest?.toLowerCase() !== input.buildDigest.toLowerCase()) {
      return NextResponse.json({ error: "不可变注册版本已有不同 buildDigest" }, { status: 409 });
    }
    if (row.state === "building" && row.leaseId?.toLowerCase() !== input.leaseId.toLowerCase()) {
      return NextResponse.json({ error: "该构建版本仍由另一枚 lease 处理" }, { status: 409 });
    }
    if (input.sourceDigest && row.sourceDigest?.toLowerCase() !== input.sourceDigest.toLowerCase()) {
      return NextResponse.json({ error: "sourceDigest 与注册来源不一致" }, { status: 409 });
    }
    if (input.manifestDigest && row.manifestDigest?.toLowerCase() !== input.manifestDigest.toLowerCase()) {
      return NextResponse.json({ error: "manifestDigest 与注册清单不一致" }, { status: 409 });
    }
    if ((input.artifactPath && row.artifactLocator !== input.artifactPath)
      || (input.artifactEntry && row.artifactEntry !== input.artifactEntry)) {
      return NextResponse.json({ error: "不可变注册版本已有不同 artifact 路径" }, { status: 409 });
    }
    return NextResponse.json({ state: row.state, buildDigest: row.buildDigest }, { headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json({
    ...result.rows[0],
    next: "operator_must_activate_registration",
  }, { headers: { "cache-control": "no-store" } });
}

interface BuilderRequest {
  registrationId?: string;
  leaseId?: string;
  buildDigest?: string;
  sourceDigest?: string;
  manifestDigest?: string;
  /** Relative path staged below MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT. */
  artifactPath?: string;
  /** Relative HTML entry within artifactPath; defaults to index.html in SQL. */
  artifactEntry?: string;
}

function validateArtifactPath(path: string | undefined, entry: string | undefined): string | null {
  if (path !== undefined && !isSafeRelativePath(path, 512)) return "artifactPath 必须是无 traversal 的相对目录";
  if (entry !== undefined && !isSafeRelativePath(entry, 256)) return "artifactEntry 必须是无 traversal 的相对文件路径";
  if (entry !== undefined && !path) return "artifactEntry 只能随 artifactPath 一起提供";
  return null;
}

function isSafeRelativePath(value: string, maximum: number): boolean {
  return value.length >= 1
    && value.length <= maximum
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}
