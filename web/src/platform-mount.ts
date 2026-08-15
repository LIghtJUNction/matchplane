import { authDatabase } from "./lib/auth";

/**
 * Production UI routes are controlled by the same immutable registration tree
 * that drives Agent delegation. Test/development profiles may render a static
 * package for local UI work, but production fails closed when the mount is not
 * active.
 */
export async function isMountedPlatformPath(platformPath: string): Promise<boolean> {
  if (process.env.MATCHPLANE_ENVIRONMENT !== "production") return true;
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isPlatformPath(platformPath)) return false;

  try {
    const result = await authDatabase.query(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id,
                o.slug,
                o."parentOrganizationId",
                o."tenantId",
                '/' || o.slug AS platform_path
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
         UNION ALL
         SELECT child.id,
                child.slug,
                child."parentOrganizationId",
                child."tenantId",
                platform_tree.platform_path || '/' || child.slug
           FROM "organization" child
           JOIN platform_tree
             ON child."parentOrganizationId" = platform_tree.id::text
            AND child."tenantId" = platform_tree."tenantId"
          WHERE length(platform_tree.platform_path) < 4_096
       )
       SELECT 1
         FROM platform_tree
        WHERE platform_tree.platform_path = $2
          AND EXISTS (
            SELECT 1
              FROM subplatform_registrations registration
             WHERE registration.tenant_id = $1::uuid
               AND registration.slug = platform_tree.slug
               AND registration.state = 'active'
          )
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    return result.rowCount === 1;
  } catch (error) {
    console.error("platform mount lookup failed", error);
    return false;
  }
}

function isPlatformPath(value: string): boolean {
  return value === "/" || /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
