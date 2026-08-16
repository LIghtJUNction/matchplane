import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";

export const runtime = "nodejs";

interface RootContactField {
  key: string;
  label: string;
  type?: "text" | "tel" | "email";
  required?: boolean;
  placeholder?: string;
}

/**
 * Bounded, secret-free first-run status for the root platform workspace.
 *
 * This endpoint intentionally does not expose account addresses, credentials, or database
 * identifiers beyond the configured root tenant and explicitly configured root organization.
 * It gives the administrator UI enough information to distinguish an empty installation from an
 * active platform without seeding demo organizations or pretending that payment/routing data
 * exists. The root organization is returned only when the operator has created it through the
 * Better Auth bridge (or pinned its UUID explicitly), never by treating a child package as root.
 */
export async function GET(): Promise<Response> {
  const configuredTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  const tenantConfigured = isUuid(configuredTenantId);
  const configuredRootOrganizationId = process.env.MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID?.trim() ?? "";
  const rootOrganizationConfigured = isUuid(configuredRootOrganizationId);
  const rootAdminConfigured = isOperatorEmail(process.env.MATCHPLANE_ROOT_ADMIN_EMAIL);

  try {
    const [tenantResult, rootOrganizationResult, domainsResult, registrationResult, accountResult, rootAdminResult] = await Promise.all([
      tenantConfigured
        ? authDatabase.query<{ slug: string; name: string }>(
            "SELECT slug, name FROM tenants WHERE id = $1::uuid LIMIT 1",
            [configuredTenantId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ slug: string; name: string }>; rowCount: number }),
      tenantConfigured
        ? authDatabase.query<{ id: string; slug: string; name: string; tenantId: string; domainId: string | null }>(
            `SELECT id::text, slug, name, "tenantId" AS "tenantId", NULLIF("domainId", '') AS "domainId"
               FROM "organization"
              WHERE "tenantId" = $1
                AND "parentOrganizationId" IS NULL
                AND "rootPlatform" = true
                AND ($2::uuid IS NULL OR id = $2::uuid)
              LIMIT 1`,
            [configuredTenantId, rootOrganizationConfigured ? configuredRootOrganizationId : null],
          )
        : Promise.resolve({ rows: [], rowCount: 0 } as { rows: Array<{ id: string; slug: string; name: string; tenantId: string; domainId: string | null }>; rowCount: number }),
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
      authDatabase.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM "user"
          WHERE "emailVerified" = true
            AND lower(email) = lower($1)
            AND role = ANY($2::text[])`,
        [process.env.MATCHPLANE_ROOT_ADMIN_EMAIL?.trim() ?? "", ["rootSuperAdmin", "rootAdmin"]],
      ),
    ]);

    const registrations = Object.fromEntries(
      registrationResult.rows.map((row) => [row.state, Number.parseInt(row.count, 10) || 0]),
    );
    const tenant = tenantResult.rows[0] ?? null;
    const rootOrganization = rootOrganizationResult.rows[0] ?? null;
    const identityAccounts = Number.parseInt(accountResult.rows[0]?.count ?? "0", 10) || 0;
    const rootAdminAccounts = Number.parseInt(rootAdminResult.rows[0]?.count ?? "0", 10) || 0;
    const activeChildren = registrations.active ?? 0;
    const contactFields = readRootContactFields();

    return NextResponse.json(
      {
        status: "ok",
        root: {
          tenantConfigured,
          tenantExists: Boolean(tenant),
          tenantId: tenantConfigured ? configuredTenantId : null,
          tenant: tenant ? { slug: tenant.slug, name: tenant.name } : null,
          organization: rootOrganization,
          rootAdminConfigured,
          identityAccounts,
          rootAdminAccounts,
          ...(contactFields ? { ui: { contactFields } } : {}),
        },
        domains: domainsResult.rows,
        registrations,
        routing: { activeChildren, ready: activeChildren > 0 },
        firstRun: {
          needsRootAccount: rootAdminAccounts === 0,
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

/**
 * Root contact channels are operator configuration, never a kernel default.  Keeping this
 * bounded and secret-free lets the root UI render the same participant profile form as a child
 * package without embedding any vertical's field names in the web bundle.
 */
function readRootContactFields(): RootContactField[] | undefined {
  const raw = process.env.MATCHPLANE_ROOT_CONTACT_FIELDS_JSON?.trim();
  if (!raw || raw.length > 32_768) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const fields = parsed.flatMap((value): RootContactField[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const field = value as Record<string, unknown>;
      const key = typeof field.key === "string" ? field.key.trim() : "";
      const label = typeof field.label === "string" ? field.label.trim() : "";
      const type = field.type === "text" || field.type === "tel" || field.type === "email" ? field.type : undefined;
      const placeholder = typeof field.placeholder === "string" ? field.placeholder.trim() : undefined;
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || !label || label.length > 200) return [];
      if (placeholder !== undefined && placeholder.length > 200) return [];
      return [{
        key,
        label,
        ...(type ? { type } : {}),
        ...(field.required === true ? { required: true } : {}),
        ...(placeholder ? { placeholder } : {}),
      }];
    }).slice(0, 32);
    return fields.length ? fields : undefined;
  } catch {
    return undefined;
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
