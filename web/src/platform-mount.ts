import { authDatabase } from "./lib/auth";

export interface MountedPlatformScope {
  tenantId: string;
  domainId: string;
  slug: string;
}

/**
 * Production UI routes are controlled by the same immutable registration tree
 * that drives Agent delegation. Test/development profiles may render a static
 * package for local UI work, but production fails closed when the mount is not
 * active.
 */
export async function isMountedPlatformPath(platformPath: string): Promise<boolean> {
  if (process.env.MATCHPLANE_ENVIRONMENT !== "production") return true;
  // The deployment root exists independently of a child registration. A
  // missing root tenant only disables recursive delegation; it must not make
  // the root chat itself unreachable.
  if (platformPath === "/") return true;
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isPlatformPath(platformPath)) return false;

  try {
    const result = await authDatabase.query(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id,
                o.slug,
                o."parentOrganizationId",
                o."tenantId",
                '/'::text AS platform_path,
                true AS path_active
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
            AND o."rootPlatform" = true
         UNION ALL
         SELECT child.id,
                child.slug,
                child."parentOrganizationId",
                child."tenantId",
                CASE WHEN platform_tree.platform_path = '/' THEN '/' || child.slug
                     ELSE platform_tree.platform_path || '/' || child.slug END,
                platform_tree.path_active
                  AND EXISTS (
                    SELECT 1
                      FROM subplatform_registrations registration
                     WHERE registration.tenant_id = $1::uuid
                       AND registration.slug = child.slug
                       AND registration.domain_id = NULLIF(child."domainId", '')::uuid
                       AND registration.state = 'active'
                       AND EXISTS (
                         SELECT 1
                           FROM domains domain
                          WHERE domain.id = registration.domain_id
                            AND domain.tenant_id = registration.tenant_id
                            AND domain.status = 'active'
                       )
                  ) AS path_active
           FROM "organization" child
           JOIN platform_tree
             ON child."parentOrganizationId" = platform_tree.id
            AND child."tenantId" = platform_tree."tenantId"
          WHERE length(platform_tree.platform_path) < 4_096
       )
       SELECT 1
         FROM platform_tree
        WHERE platform_tree.platform_path = $2
          AND platform_tree.path_active
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    return result.rowCount === 1;
  } catch (error) {
    console.error("platform mount lookup failed", error);
    return false;
  }
}

/**
 * Resolves the active node from the immutable organization tree.  Callers must use this result
 * instead of trusting a browser-supplied tenant/domain pair for a child capability exchange.
 */
export async function readActivePlatformScope(
  platformPath: string,
): Promise<MountedPlatformScope | null> {
  if (process.env.MATCHPLANE_ENVIRONMENT !== "production" || platformPath === "/") return null;
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isPlatformPath(platformPath)) return null;
  try {
    const result = await authDatabase.query<MountedPlatformScope>(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id,
                o.slug,
                o."parentOrganizationId",
                o."tenantId" AS tenant_id,
                o."domainId" AS domain_id,
                '/'::text AS platform_path,
                true AS path_active
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
            AND o."rootPlatform" = true
         UNION ALL
         SELECT child.id,
                child.slug,
                child."parentOrganizationId",
                child."tenantId",
                child."domainId",
                CASE WHEN platform_tree.platform_path = '/' THEN '/' || child.slug
                     ELSE platform_tree.platform_path || '/' || child.slug END,
                platform_tree.path_active
                  AND EXISTS (
                    SELECT 1
                      FROM subplatform_registrations registration
                     WHERE registration.tenant_id = $1::uuid
                       AND registration.domain_id = NULLIF(child."domainId", '')::uuid
                       AND registration.slug = child.slug
                       AND registration.state = 'active'
                       AND EXISTS (
                         SELECT 1
                           FROM domains domain
                          WHERE domain.id = registration.domain_id
                            AND domain.tenant_id = registration.tenant_id
                            AND domain.status = 'active'
                       )
                  )
           FROM "organization" child
           JOIN platform_tree ON child."parentOrganizationId" = platform_tree.id
          WHERE length(platform_tree.platform_path) < 4_096
       )
       SELECT tenant_id AS "tenantId", domain_id AS "domainId", slug
         FROM platform_tree
        WHERE platform_path = $2
          AND path_active
          AND NULLIF(domain_id, '') IS NOT NULL
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    const row = result.rows[0];
    return row && isUuid(row.tenantId) && isUuid(row.domainId)
      ? row
      : null;
  } catch (error) {
    console.error("active platform scope lookup failed", error);
    return null;
  }
}

/**
 * Limit a machine key to its organization node and descendants. The root deployment can opt into
 * a root-scoped key with MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID; without that explicit binding a
 * child key cannot submit a request at `/`.
 */
export async function isPlatformPathAccessibleByOrganization(
  platformPath: string,
  organizationId: string,
): Promise<boolean> {
  if (platformPath === "/") {
    const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
    if (!rootTenantId || !isUuid(rootTenantId) || !isUuid(organizationId)) return false;
    const configuredRootOrganizationId = process.env.MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID?.trim() ?? "";
    try {
      const result = await authDatabase.query(
        `SELECT 1
           FROM "organization"
          WHERE id = $1::uuid
            AND "tenantId" = $2
            AND "parentOrganizationId" IS NULL
            AND "rootPlatform" = true
            AND ($3::uuid IS NULL OR id = $3::uuid)
          LIMIT 1`,
        [organizationId, rootTenantId, isUuid(configuredRootOrganizationId) ? configuredRootOrganizationId : null],
      );
      return result.rowCount === 1;
    } catch (error) {
      console.error("root platform organization lookup failed", error);
      return false;
    }
  }
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isUuid(organizationId) || !isPlatformPath(platformPath)) return false;

  try {
    const result = await authDatabase.query(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id,
                o."parentOrganizationId",
                o."tenantId",
                '/'::text AS platform_path,
                true AS path_active
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
            AND o."rootPlatform" = true
         UNION ALL
         SELECT child.id,
                child."parentOrganizationId",
                child."tenantId",
                CASE WHEN platform_tree.platform_path = '/' THEN '/' || child.slug
                     ELSE platform_tree.platform_path || '/' || child.slug END,
                platform_tree.path_active
                  AND EXISTS (
                    SELECT 1
                      FROM subplatform_registrations registration
                     WHERE registration.tenant_id = $1::uuid
                       AND registration.slug = child.slug
                       AND registration.domain_id = NULLIF(child."domainId", '')::uuid
                       AND registration.state = 'active'
                       AND EXISTS (
                         SELECT 1
                           FROM domains domain
                          WHERE domain.id = registration.domain_id
                            AND domain.tenant_id = registration.tenant_id
                            AND domain.status = 'active'
                       )
                  ) AS path_active
           FROM "organization" child
           JOIN platform_tree
             ON child."parentOrganizationId" = platform_tree.id
            AND child."tenantId" = platform_tree."tenantId"
          WHERE length(platform_tree.platform_path) < 4_096
       ),
       key_scope(id, depth) AS (
         SELECT id, 0
           FROM "organization"
          WHERE id = $2::uuid
         UNION ALL
         SELECT child.id, parent.depth + 1
           FROM "organization" child
           JOIN key_scope parent ON child."parentOrganizationId" = parent.id
          WHERE parent.depth < 64
       )
       SELECT 1
         FROM platform_tree
         JOIN key_scope ON key_scope.id = platform_tree.id
        WHERE platform_tree.platform_path = $3
          AND platform_tree.path_active
        LIMIT 1`,
      [rootTenantId, organizationId, platformPath],
    );
    return result.rowCount === 1;
  } catch (error) {
    console.error("platform API-key mount lookup failed", error);
    return false;
  }
}

function isPlatformPath(value: string): boolean {
  return value === "/" || /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
