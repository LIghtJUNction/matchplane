import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import { hasValidConfiguredSubplatformBuilderToken } from "../../../../../../src/subplatform-builder";

export const runtime = "nodejs";

/**
 * Lease one immutable registration for the isolated static-package builder.
 *
 * This route is machine-only.  It deliberately returns source metadata rather
 * than a database credential; the worker mounts only the opaque upload and
 * artifact directories and calls the build callback with the returned lease.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await hasValidConfiguredSubplatformBuilderToken(request.headers.get("x-matchplane-builder-token")))) {
    return NextResponse.json({ error: "isolated builder authentication is required" }, { status: 401 });
  }

  const leaseSeconds = boundedInteger(process.env.MATCHPLANE_SUBPLATFORM_BUILDER_LEASE_SECONDS, 900, 60, 3_600);
  const result = await authDatabase.query(
    `WITH candidate AS (
       SELECT id
         FROM subplatform_registrations
        WHERE source_kind IN ('git', 'archive')
          AND build_attempts < 100
          AND (
            state = 'validated'
            OR (
              state = 'building'
              AND (build_started_at IS NULL
                   OR build_started_at < clock_timestamp() - make_interval(secs => $1::int))
            )
          )
        ORDER BY registered_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE subplatform_registrations registration
        SET state = 'building',
            build_lease_id = gen_random_uuid(),
            build_started_at = clock_timestamp(),
            build_attempts = registration.build_attempts + 1,
            build_error = NULL,
            updated_at = clock_timestamp()
       FROM candidate
      WHERE registration.id = candidate.id
      RETURNING registration.id,
                registration.tenant_id AS "tenantId",
                registration.domain_id AS "domainId",
                registration.package_id AS "packageId",
                registration.slug,
                registration.source_kind AS "sourceKind",
                registration.source_locator AS "sourceLocator",
                registration.pinned_revision AS "pinnedRevision",
                encode(registration.source_digest, 'hex') AS "sourceDigest",
                encode(registration.manifest_digest, 'hex') AS "manifestDigest",
                registration.build_lease_id AS "leaseId",
                registration.build_attempts AS "buildAttempts",
                registration.build_started_at AS "leaseStartedAt"`,
    [leaseSeconds],
  );

  const job = result.rows[0];
  if (!job) {
    return NextResponse.json(
      { job: null, retryAfterMs: 2_000 },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    { job, leaseSeconds },
    { headers: { "cache-control": "no-store" } },
  );
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}
