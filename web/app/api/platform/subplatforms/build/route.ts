import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import { hasValidSubplatformBuilderToken } from "../../../../../src/subplatform-builder";

export const runtime = "nodejs";

/**
 * Internal callback for the isolated package builder. A browser/admin session
 * cannot manufacture a build digest; only the builder secret may attach the
 * digest that activation later pins.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasValidSubplatformBuilderToken(
    process.env.MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN,
    request.headers.get("x-matchplane-builder-token"),
  )) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }

  const input = await parseBody(request);
  if (!input.registrationId || !isUuid(input.registrationId)) {
    return NextResponse.json({ error: "registrationId must be a UUID" }, { status: 400 });
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
            state = CASE WHEN state = 'validated' THEN 'ready' ELSE state END,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND state IN ('validated', 'building', 'ready')
        AND (build_digest IS NULL OR build_digest = decode($2, 'hex'))
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
    [input.registrationId, input.buildDigest.toLowerCase(), input.artifactPath ?? null, input.artifactEntry ?? null],
  );
  if (result.rowCount !== 1) {
    const existing = await authDatabase.query(
      `SELECT state, encode(build_digest, 'hex') AS "buildDigest",
              artifact_locator AS "artifactLocator", artifact_entry AS "artifactEntry"
         FROM subplatform_registrations
        WHERE id = $1::uuid
        LIMIT 1`,
      [input.registrationId],
    );
    const row = existing.rows[0] as {
      state?: string;
      buildDigest?: string | null;
      artifactLocator?: string | null;
      artifactEntry?: string | null;
    } | undefined;
    if (!row) return NextResponse.json({ error: "子平台注册记录不存在" }, { status: 404 });
    if (row.buildDigest?.toLowerCase() !== input.buildDigest.toLowerCase()) {
      return NextResponse.json({ error: "不可变注册版本已有不同 buildDigest" }, { status: 409 });
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
  buildDigest?: string;
  /** Relative path staged below MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT. */
  artifactPath?: string;
  /** Relative HTML entry within artifactPath; defaults to index.html in SQL. */
  artifactEntry?: string;
}

async function parseBody(request: Request): Promise<BuilderRequest> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as BuilderRequest : {};
  } catch {
    return {};
  }
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
