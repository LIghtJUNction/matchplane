import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";

export const runtime = "nodejs";

/**
 * Bounded, secret-free first-run status for the root platform workspace.
 *
 * This endpoint intentionally does not expose account addresses, credentials, or database
 * identifiers beyond the configured root tenant id. It gives the administrator UI enough
 * information to distinguish an empty installation from an active platform without seeding
 * demo organizations or pretending that payment/routing data exists.
 */
export async function GET(): Promise<Response> {
  const configuredTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  const tenantConfigured = isUuid(configuredTenantId);
  const rootAdminConfigured = isOperatorEmail(process.env.MATCHPLANE_ROOT_ADMIN_EMAIL);

  try {
    const [tenantResult, domainsResult, registrationResult, accountResult] = await Promise.all([
      tenantConfigured
        ? authDatabase.query<{ slug: string; name: string }>(
            "SELECT slug, name FROM tenants WHERE id = $1::uuid LIMIT 1",
            [configuredTenantId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ slug: string; name: string }>; rowCount: number }),
      tenantConfigured
        ? authDatabase.query<{ id: string; slug: string; name: string }>(
            `SELECT id, slug, name
               FROM domains
              WHERE tenant_id = $1::uuid AND status = 'active'
              ORDER BY slug ASC`,
            [configuredTenantId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: string; slug: string; name: string }>; rowCount: number }),
      tenantConfigured
        ? authDatabase.query<{ state: string; count: string }>(
            `SELECT state, count(*)::text AS count
               FROM subplatform_registrations
              WHERE tenant_id = $1::uuid
              GROUP BY state
              ORDER BY state ASC`,
            [configuredTenantId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ state: string; count: string }>; rowCount: number }),
      authDatabase.query<{ count: string }>('SELECT count(*)::text AS count FROM "user"'),
    ]);

    const registrations = Object.fromEntries(
      registrationResult.rows.map((row) => [row.state, Number.parseInt(row.count, 10) || 0]),
    );
    const tenant = tenantResult.rows[0] ?? null;
    const identityAccounts = Number.parseInt(accountResult.rows[0]?.count ?? "0", 10) || 0;
    const activeChildren = registrations.active ?? 0;

    return NextResponse.json(
      {
        status: "ok",
        root: {
          tenantConfigured,
          tenantExists: Boolean(tenant),
          tenant: tenant ? { slug: tenant.slug, name: tenant.name } : null,
          rootAdminConfigured,
          identityAccounts,
        },
        domains: domainsResult.rows,
        registrations,
        routing: { activeChildren, ready: activeChildren > 0 },
        firstRun: {
          needsRootAccount: identityAccounts === 0,
          readyForAdmin: rootAdminConfigured && Boolean(tenant),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("platform setup status failed", error);
    return NextResponse.json(
      { status: "degraded", error: "platform setup status unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

function isOperatorEmail(value: string | undefined): boolean {
  const email = value?.trim().toLowerCase() ?? "";
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !email.endsWith("@example.com")
    && !email.endsWith("@example.org")
    && !email.endsWith("@example.net");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
