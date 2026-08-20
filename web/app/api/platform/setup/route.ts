import { NextResponse } from "next/server";
import { statSync } from "node:fs";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { isPlatformRouterConfigured } from "../../../../src/platform-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RootContactField {
  key: string;
  label: string;
  type?: "text" | "tel" | "email";
  required?: boolean;
  placeholder?: string;
}

interface RootChatConfig {
  buyerHeadlines?: string[];
  sellerHeadlines?: string[];
}

interface PlatformBuilderStatus {
  configured: boolean;
  status: "ready" | "degraded" | "unconfigured";
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
export async function GET(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return NextResponse.json({ error: "当前账号没有商城运营权限" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
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
            AND role = ANY($1::text[])`,
        [["rootSuperAdmin", "rootAdmin"]],
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
    const chat = readRootChatConfig();
    const builder = readBuilderStatus();

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
          ...(contactFields || chat ? { ui: { ...(contactFields ? { contactFields } : {}), ...(chat ? { chat } : {}) } } : {}),
        },
        domains: domainsResult.rows,
        registrations,
        routing: { activeChildren, ready: activeChildren > 0 },
        hostedAgent: {
          configured: isPlatformRouterConfigured(),
          // The deterministic policy path remains available as an explicit degradation, but
          // administrators should be able to see that no platform-owned model is connected.
          status: isPlatformRouterConfigured() ? "ready" : "fallback",
        },
        builder,
        firstRun: {
          needsRootAccount: rootAdminAccounts === 0,
          // An operator may bootstrap the first account either through the configured
          // root-admin address or through a one-time CLI invitation. Count the verified
          // role projection rather than treating the env var as proof that an account exists.
          readyForAdmin: Boolean(tenant) && rootAdminAccounts > 0,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("platform setup status failed", error);
    return NextResponse.json(
      {
        status: "degraded",
        error: "platform setup status unavailable",
        root: {
          tenantConfigured,
          tenantExists: false,
          tenantId: tenantConfigured ? configuredTenantId : null,
          tenant: null,
          organization: null,
          rootAdminConfigured,
          identityAccounts: 0,
          rootAdminAccounts: 0,
        },
        domains: [],
        registrations: {},
        routing: { activeChildren: 0, ready: false },
        hostedAgent: { configured: false, status: "fallback" },
        builder: readBuilderStatus(),
        firstRun: { needsRootAccount: true, readyForAdmin: false },
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}

/**
 * Report only whether the isolated static builder can be started.  Never expose the token,
 * secret path, or host paths to a browser; an unconfigured builder must be visible to operators
 * so package registration cannot look like a successful production activation.
 */
function readBuilderStatus(): PlatformBuilderStatus {
  const webUrl = process.env.MATCHPLANE_SUBPLATFORM_BUILDER_WEB_URL?.trim();
  const artifactRoot = process.env.MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT?.trim();
  const uploadRoot = process.env.MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT?.trim();
  const workRoot = process.env.MATCHPLANE_SUBPLATFORM_BUILDER_WORK_ROOT?.trim();
  const tokenFile = process.env.MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN_FILE?.trim();
  const tokenConfigured = Boolean(process.env.MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN?.trim())
    || Boolean(tokenFile && hasNonEmptyFile(tokenFile));
  if (!webUrl || !artifactRoot || !uploadRoot || !workRoot || !tokenConfigured) {
    return { configured: false, status: "unconfigured" };
  }
  const bwrap = process.env.MATCHPLANE_SUBPLATFORM_BUILDER_BWRAP?.trim();
  const runtimeAvailable = bwrap
    ? isExecutableFile(bwrap)
    : ["/usr/bin/bwrap", "/usr/bin/bubblewrap", "/usr/local/bin/bwrap"].some(isExecutableFile);
  const packageManagerAvailable = readBuilderPackageManagerPaths().some(isExecutableFile);
  return { configured: true, status: runtimeAvailable && packageManagerAvailable ? "ready" : "degraded" };
}

function readBuilderPackageManagerPaths(): string[] {
  const configuredBun = process.env.MATCHPLANE_SUBPLATFORM_BUILDER_BUN?.trim();
  if (configuredBun) return [configuredBun];
  return [
    "/usr/local/bin/bun",
    "/usr/local/bin/npm",
    "/usr/local/bin/pnpm",
    "/usr/local/bin/yarn",
    "/usr/bin/bun",
    "/usr/bin/npm",
    "/usr/bin/pnpm",
    "/usr/bin/yarn",
    "/bin/bun",
    "/bin/npm",
    "/bin/pnpm",
    "/bin/yarn",
    "/opt/bun/bin/bun",
  ];
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    return process.platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function hasNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
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

/** Root headline rotation is operator configuration, not a hard-coded vertical label. */
function readRootChatConfig(): RootChatConfig | undefined {
  const raw = process.env.MATCHPLANE_ROOT_CHAT_HEADLINES_JSON?.trim();
  if (!raw || raw.length > 32_768) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    const headlines = (candidate: unknown): string[] | undefined => {
      if (!Array.isArray(candidate)) return undefined;
      const items = candidate
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 160)
        .map((item) => item.trim())
        .slice(0, 12);
      return items.length ? items : undefined;
    };
    const buyerHeadlines = headlines(value.buyer ?? value.buyerHeadlines);
    const sellerHeadlines = headlines(value.seller ?? value.sellerHeadlines);
    return buyerHeadlines || sellerHeadlines ? {
      ...(buyerHeadlines ? { buyerHeadlines } : {}),
      ...(sellerHeadlines ? { sellerHeadlines } : {}),
    } : undefined;
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
