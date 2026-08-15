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

  const result = await authDatabase.query(
    `UPDATE subplatform_registrations
        SET build_digest = decode($2, 'hex'),
            state = CASE WHEN state = 'validated' THEN 'ready' ELSE state END,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND state IN ('validated', 'building', 'ready')
        AND (build_digest IS NULL OR build_digest = decode($2, 'hex'))
      RETURNING id,
                state,
                encode(build_digest, 'hex') AS "buildDigest",
                tenant_id AS "tenantId",
                domain_id AS "domainId",
                slug,
                version`,
    [input.registrationId, input.buildDigest.toLowerCase()],
  );
  if (result.rowCount !== 1) {
    const existing = await authDatabase.query(
      `SELECT state, encode(build_digest, 'hex') AS "buildDigest"
         FROM subplatform_registrations
        WHERE id = $1::uuid
        LIMIT 1`,
      [input.registrationId],
    );
    const row = existing.rows[0] as { state?: string; buildDigest?: string | null } | undefined;
    if (!row) return NextResponse.json({ error: "子平台注册记录不存在" }, { status: 404 });
    if (row.buildDigest?.toLowerCase() !== input.buildDigest.toLowerCase()) {
      return NextResponse.json({ error: "不可变注册版本已有不同 buildDigest" }, { status: 409 });
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
}

async function parseBody(request: Request): Promise<BuilderRequest> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as BuilderRequest : {};
  } catch {
    return {};
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
