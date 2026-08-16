import { authDatabase } from "./lib/auth";

/**
 * Public, active direct-child metadata used by both the hosted router and an
 * external Agent handoff.  Tenant/domain identifiers remain available to the
 * server-side router but are not part of the public handoff projection.
 */
export interface PlatformChildRoute {
  slug: string;
  path: string;
  displayName: string;
  description: string;
  tenantId: string;
  domainId: string;
  capabilities: string[];
  agentStages: string[];
  agentSkills: string[];
  agentMcpTools: string[];
  depth: 1;
}

export async function readActiveDirectChildRoutes(
  platformPath: string,
  rootTenantId: string,
  viewer?: {
    /** Better Auth user id for a human session. */
    authUserId?: string | null;
    /** Better Auth organization id for a scoped Agent API key. */
    organizationId?: string | null;
    /** Root operators may enumerate private descendants for administration. */
    isRootAdministrator?: boolean;
  },
): Promise<PlatformChildRoute[]> {
  const result = await authDatabase.query(
    `WITH RECURSIVE platform_tree AS (
       SELECT root.id,
              root.slug,
              root."parentOrganizationId",
              root."tenantId",
              '/'::text AS platform_path,
              true AS path_active,
              0 AS depth
         FROM "organization" root
        WHERE root."tenantId" = $2::text
          AND root."parentOrganizationId" IS NULL
          AND root."rootPlatform" = true
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
                   WHERE registration.tenant_id = $2::uuid
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
         JOIN platform_tree ON child."parentOrganizationId" = platform_tree.id
                           AND child."tenantId" = platform_tree."tenantId"
        WHERE platform_tree.depth < 64
          AND length(platform_tree.platform_path) < 4_096
     ), current_node AS (
       SELECT id, path_active
         FROM platform_tree
        WHERE platform_path = $1::text
          AND path_active
     )
     SELECT r.slug,
            COALESCE(r.manifest ->> 'displayName', r.slug) AS "displayName",
            COALESCE(r.manifest ->> 'description', '') AS description,
            r.tenant_id AS "tenantId",
            r.domain_id AS "domainId",
            CASE WHEN $1::text = '/' THEN '/' || r.slug
                 ELSE $1::text || '/' || r.slug
            END AS path,
            COALESCE(r.manifest -> 'capabilities', '[]'::jsonb) AS capabilities,
            COALESCE(r.manifest -> 'agent' -> 'stages', '[]'::jsonb) AS "agentStages",
            COALESCE(r.manifest -> 'agent' -> 'skills', '[]'::jsonb) AS "agentSkills",
            COALESCE(r.manifest -> 'agent' -> 'mcpTools', '[]'::jsonb) AS "agentMcpTools"
       FROM subplatform_registrations r
       JOIN "organization" o ON o.slug = r.slug
                            AND o."tenantId" = r.tenant_id::text
                            AND o."rootPlatform" = false
       JOIN platform_tree node ON node.id = o.id
                              AND node.path_active
       JOIN platform_tree parent ON parent.id = o."parentOrganizationId"
                                AND parent.path_active
       JOIN domains d ON d.id = r.domain_id AND d.tenant_id = r.tenant_id AND d.status = 'active'
       JOIN current_node ON current_node.id = parent.id
      WHERE r.tenant_id = $2::uuid
        AND r.state = 'active'
        AND r.domain_id = NULLIF(o."domainId", '')::uuid
        AND (
          r.membership_policy = 'public'
          OR ($3::uuid IS NOT NULL AND EXISTS (
            SELECT 1
              FROM "member" m
             WHERE m."organizationId" = o.id
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
            SELECT 1 FROM key_scope WHERE id = o.id
          ))
          OR ($5::boolean IS TRUE)
        )
        AND o."parentOrganizationId" = parent.id
      ORDER BY r.slug ASC`,
    [
      platformPath,
      rootTenantId,
      viewer?.authUserId ?? null,
      viewer?.organizationId ?? null,
      viewer?.isRootAdministrator === true,
    ],
  );

  return result.rows.map((row) => ({
    slug: String(row.slug),
    path: safeRoutePath(String(row.path), String(row.slug)),
    displayName: String(row.displayName),
    description: String(row.description),
    tenantId: String(row.tenantId),
    domainId: String(row.domainId),
    capabilities: boundedStrings(row.capabilities, 64),
    agentStages: boundedStrings(row.agentStages, 8),
    agentSkills: boundedStrings(row.agentSkills, 32),
    agentMcpTools: boundedStrings(row.agentMcpTools, 64),
    depth: 1,
  }));
}

function boundedStrings(value: unknown, maximum: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, maximum)
    : [];
}

function safeRoutePath(value: string, fallbackSlug: string): string {
  return /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value) ? value : `/${fallbackSlug}`;
}
