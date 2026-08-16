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
  const currentSlug = platformPath === "/" ? null : platformPath.split("/").filter(Boolean).at(-1) ?? null;
  const result = await authDatabase.query(
    `WITH current_node AS (
       SELECT o.id
         FROM "organization" o
        WHERE $1::text IS NOT NULL
          AND o.slug = $1::text
          AND o."tenantId" = $2::text
     )
     SELECT r.slug,
            COALESCE(r.manifest ->> 'displayName', r.slug) AS "displayName",
            COALESCE(r.manifest ->> 'description', '') AS description,
            r.tenant_id AS "tenantId",
            r.domain_id AS "domainId",
            CASE WHEN $3::text = '/' THEN '/' || r.slug
                 ELSE $3::text || '/' || r.slug
            END AS path,
            COALESCE(r.manifest -> 'capabilities', '[]'::jsonb) AS capabilities,
            COALESCE(r.manifest -> 'agent' -> 'stages', '[]'::jsonb) AS "agentStages",
            COALESCE(r.manifest -> 'agent' -> 'skills', '[]'::jsonb) AS "agentSkills",
            COALESCE(r.manifest -> 'agent' -> 'mcpTools', '[]'::jsonb) AS "agentMcpTools"
       FROM subplatform_registrations r
       JOIN "organization" o ON o.slug = r.slug AND o."tenantId" = r.tenant_id::text
       LEFT JOIN current_node ON true
      WHERE r.tenant_id = $2::uuid
        AND r.state = 'active'
        AND (
          r.membership_policy = 'public'
          OR ($4::uuid IS NOT NULL AND EXISTS (
            SELECT 1
              FROM "member" m
             WHERE m."organizationId" = o.id
               AND m."userId" = $4::uuid
          ))
          OR ($5::uuid IS NOT NULL AND EXISTS (
            WITH RECURSIVE key_scope(id, depth) AS (
              SELECT $5::uuid, 0
              UNION ALL
              SELECT child.id, parent.depth + 1
                FROM "organization" child
                JOIN key_scope parent ON child."parentOrganizationId" = parent.id
               WHERE parent.depth < 64
            )
            SELECT 1 FROM key_scope WHERE id = o.id
          ))
          OR ($6::boolean IS TRUE)
        )
        AND (($1::text IS NULL AND o."parentOrganizationId" IS NULL)
          OR ($1::text IS NOT NULL AND current_node.id IS NOT NULL
              AND o."parentOrganizationId" = current_node.id))
      ORDER BY r.slug ASC`,
    [
      currentSlug,
      rootTenantId,
      platformPath,
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
