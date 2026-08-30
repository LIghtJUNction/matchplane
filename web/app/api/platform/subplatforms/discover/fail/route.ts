import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../../src/lib/body-limit";
import { hasValidConfiguredSubplatformBuilderToken } from "../../../../../../src/subplatform-builder";
import { isUuid } from "../../../../../../src/lib/uuid";
import { jsonError } from "../../../../../../src/lib/json-error";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!(await hasValidConfiguredSubplatformBuilderToken(request.headers.get("x-matchplane-builder-token")))) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }
  let input: { intakeId?: unknown; leaseId?: unknown; error?: unknown; retryable?: unknown } = {};
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (value && typeof value === "object" && !Array.isArray(value)) input = value as typeof input;
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "源码发现失败回调过大" : "请求 JSON 无效", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  if (!isUuid(input.intakeId) || !isUuid(input.leaseId)) return jsonError("intakeId/leaseId 必须是 UUID", 400);
  const reason = typeof input.error === "string" ? input.error.trim().slice(0, 2_000) : "源码发现失败";
  const retryable = input.retryable === true;
  const result = await authDatabase.query(
    `UPDATE subplatform_source_intakes
        SET state = CASE
              WHEN $4::boolean AND discover_attempts < 20 THEN 'queued'
              ELSE 'rejected'
            END,
            discover_lease_id = NULL, discover_started_at = NULL, error = $3, updated_at = clock_timestamp()
      WHERE id = $1::uuid AND discover_lease_id = $2::uuid AND state = 'discovering'
      RETURNING id::text AS "intakeId", state, error`,
    [input.intakeId, input.leaseId, reason, retryable],
  );
  if (result.rowCount !== 1) return jsonError("源码导入任务不存在或 lease 已失效", 409);
  return NextResponse.json(result.rows[0], { headers: { "cache-control": "no-store" } });
}

