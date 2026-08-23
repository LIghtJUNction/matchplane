import { authDatabase } from "./lib/auth";
import { isProductionEnvironment } from "./lib/runtime";
import { isUuid } from "./lib/uuid";

export interface PlatformViewer {
  /** Better Auth user id for a human session. */
  authUserId?: string | null;
  /** Better Auth organization id for a scoped Agent API key. */
  organizationId?: string | null;
  /** Root operators can manage private descendants without being marketplace members. */
  isRootAdministrator?: boolean;
}

/**
 * A mounted path is public only when its registration says so. Invite-only
 * nodes are visible to an already invited Better Auth member or to a key bound
 * directly to that organization; knowing the URL is not an access grant.
 */
export async function isActivePlatformPathVisible(
  platformPath: string,
  viewer?: PlatformViewer,
): Promise<boolean> {
  if (platformPath === "/") return true;
  if (!isProductionEnvironment()) return true;
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isPlatformPath(platformPath)) return false;

  try {
    const store = await authDatabase.query(
      `SELECT 1
         FROM stores store
         JOIN store_path_aliases alias
           ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id
         JOIN domains domain
           ON domain.tenant_id = store.tenant_id AND domain.id = store.domain_id AND domain.status = 'active'
         LEFT JOIN subplatform_registrations registration ON registration.id = store.current_registration_id
        WHERE store.tenant_id = $1::uuid
          AND alias.path = $2
          AND store.status = 'active'
          AND (store.integration_kind = 'hosted' OR registration.state = 'active')
          AND (store.integration_kind <> 'external' OR EXISTS (
            SELECT 1 FROM platform_federation_bindings binding
             WHERE binding.id = store.federation_binding_id AND binding.status = 'active'
          ))
          AND (
            store.visibility = 'public'
            OR ($3::uuid IS NOT NULL AND EXISTS (
              SELECT 1 FROM "member" membership
               WHERE membership."organizationId" = store.organization_id
                 AND membership."userId" = $3::uuid
            ))
            OR ($4::uuid IS NOT NULL AND $4::uuid = store.organization_id)
            OR $5::boolean IS TRUE
          )
        LIMIT 1`,
      [rootTenantId, platformPath, viewer?.authUserId ?? null, viewer?.organizationId ?? null, viewer?.isRootAdministrator === true],
    );
    if (store.rowCount === 1) return true;

    const projection = await authDatabase.query(
      `SELECT 1
         FROM store_path_aliases alias
         JOIN stores store
           ON store.tenant_id = alias.tenant_id
          AND store.id = alias.store_id
        WHERE alias.tenant_id = $1::uuid
          AND alias.path = $2
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    if (projection.rowCount === 1) return false;

    const result = await authDatabase.query(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id,
                o.slug,
                o."parentOrganizationId",
                o."tenantId",
                NULL::uuid AS domain_id,
                '/'::text AS platform_path,
                true AS path_active,
                0 AS depth
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
            AND o."rootPlatform" = true
         UNION ALL
         SELECT child.id,
                child.slug,
                child."parentOrganizationId",
                child."tenantId",
                NULLIF(child."domainId", '')::uuid AS domain_id,
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
                  ),
                platform_tree.depth + 1
           FROM "organization" child
           JOIN platform_tree
             ON child."parentOrganizationId" = platform_tree.id
            AND child."tenantId" = platform_tree."tenantId"
          WHERE platform_tree.depth < 64
            AND length(platform_tree.platform_path) < 4_096
       ), target AS (
         SELECT tree.id AS organization_id,
                registration.membership_policy
           FROM platform_tree tree
           JOIN LATERAL (
             SELECT r.membership_policy
               FROM subplatform_registrations r
               JOIN domains d
                 ON d.id = r.domain_id
                AND d.tenant_id = r.tenant_id
                AND d.status = 'active'
              WHERE r.tenant_id = $1::uuid
                AND r.slug = tree.slug
                AND r.domain_id = tree.domain_id
                AND r.state = 'active'
              ORDER BY r.version DESC
              LIMIT 1
           ) registration ON true
          WHERE tree.platform_path = $2
            AND tree.path_active
       )
       SELECT 1
         FROM target
        WHERE membership_policy = 'public'
           OR ($3::uuid IS NOT NULL AND EXISTS (
             SELECT 1
               FROM "member" m
              WHERE m."organizationId" = target.organization_id
                AND m."userId" = $3::uuid
           ))
           OR ($4::uuid IS NOT NULL AND EXISTS (
             WITH RECURSIVE key_scope(id, depth) AS (
               SELECT $4::uuid, 0
               UNION ALL
               SELECT child.id, parent.depth + 1
                 FROM "organization" child
                 JOIN key_scope parent ON child."parentOrganizationId" = parent.id
                WHERE parent.depth < 64
             )
             SELECT 1 FROM key_scope WHERE id = target.organization_id
           ))
           OR ($5::boolean IS TRUE)
        LIMIT 1`,
      [
        rootTenantId,
        platformPath,
        viewer?.authUserId ?? null,
        viewer?.organizationId ?? null,
        viewer?.isRootAdministrator === true,
      ],
    );
    return result.rowCount === 1;
  } catch (error) {
    console.error("platform visibility lookup failed", error);
    return false;
  }
}

function isPlatformPath(value: string): boolean {
  return /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value);
}
