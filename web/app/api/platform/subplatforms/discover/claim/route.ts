import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import { hasValidConfiguredSubplatformBuilderToken } from "../../../../../../src/subplatform-builder";

export const runtime = "nodejs";

/** Lease one source-only intake for manifest discovery. */
export async function POST(request: Request): Promise<Response> {
  if (!(await hasValidConfiguredSubplatformBuilderToken(request.headers.get("x-matchplane-builder-token")))) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }
  const leaseSeconds = boundedInteger(process.env.MATCHPLANE_SUBPLATFORM_BUILDER_LEASE_SECONDS, 900, 60, 3_600);
  const result = await authDatabase.query(
    `WITH candidate AS (
       SELECT id
         FROM subplatform_source_intakes
        WHERE discover_attempts < 20
          AND (
            state = 'queued'
            OR (state = 'discovering' AND (discover_started_at IS NULL
                OR discover_started_at < clock_timestamp() - make_interval(secs => $1::int)))
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE subplatform_source_intakes intake
        SET state = 'discovering', discover_lease_id = gen_random_uuid(),
            discover_started_at = clock_timestamp(), discover_attempts = intake.discover_attempts + 1,
            error = NULL, updated_at = clock_timestamp()
       FROM candidate
      WHERE intake.id = candidate.id
      RETURNING intake.id, intake.tenant_id AS "tenantId", intake.domain_id AS "domainId",
                intake.parent_organization_id AS "parentOrganizationId", intake.source_kind AS "sourceKind",
                intake.source_locator AS "sourceLocator", encode(intake.source_digest, 'hex') AS "sourceDigest",
                intake.discover_lease_id AS "leaseId", intake.discover_attempts AS "discoverAttempts"`,
    [leaseSeconds],
  );
  return NextResponse.json({ job: result.rows[0] ?? null, retryAfterMs: result.rows[0] ? undefined : 2_000 }, {
    headers: { "cache-control": "no-store" },
  });
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}
