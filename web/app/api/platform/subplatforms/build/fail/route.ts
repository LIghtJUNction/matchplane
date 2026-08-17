import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import { hasValidConfiguredSubplatformBuilderToken } from "../../../../../../src/subplatform-builder";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../../src/lib/body-limit";

export const runtime = "nodejs";

/** Record a bounded builder failure and release its lease without activating anything. */
export async function POST(request: Request): Promise<Response> {
  if (!(await hasValidConfiguredSubplatformBuilderToken(request.headers.get("x-matchplane-builder-token")))) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }
  let input: FailureRequest;
  try {
    const value = await readJsonBody<unknown>(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object required");
    input = value as FailureRequest;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "构建失败回调请求过大" : "请求必须是有效 JSON" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!isUuid(input.registrationId) || !isUuid(input.leaseId)) {
    return NextResponse.json({ error: "registrationId and leaseId must be UUIDs" }, { status: 400 });
  }
  const message = readError(input.error);
  if (!message) return NextResponse.json({ error: "error must be a bounded message" }, { status: 400 });
  const retryable = input.retryable === true;
  const result = await authDatabase.query(
    `UPDATE subplatform_registrations
        SET state = CASE WHEN $3::boolean AND build_attempts < 100 THEN 'building' ELSE 'rejected' END,
            build_lease_id = NULL,
            build_started_at = CASE WHEN $3::boolean AND build_attempts < 100 THEN clock_timestamp() ELSE NULL END,
            build_error = $4,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND state = 'building'
        AND build_lease_id = $2::uuid
      RETURNING id, state, build_attempts AS "buildAttempts", build_error AS "buildError"`,
    [input.registrationId, input.leaseId, retryable, message],
  );
  if (result.rowCount !== 1) {
    return NextResponse.json({ error: "构建租约不存在、已过期或已被其他 worker 处理" }, { status: 409 });
  }
  return NextResponse.json({ ...result.rows[0], retryable }, { headers: { "cache-control": "no-store" } });
}

interface FailureRequest {
  registrationId?: unknown;
  leaseId?: unknown;
  error?: unknown;
  retryable?: unknown;
}

function readError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 4_000 ? normalized : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
