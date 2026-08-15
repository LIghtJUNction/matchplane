import { authDatabase } from "./lib/auth";

/**
 * Read the immutable manifest selected by the active recursive platform tree.
 *
 * A package checked into `public/` is useful for local development, but it is
 * not an activation grant in production. The database record is the source of
 * truth so a dynamically registered child (including a grandchild) receives
 * the same manifest path as the routing Agent.
 */
export async function readActivePlatformManifest(platformPath: string): Promise<string | null> {
  if (process.env.MATCHPLANE_ENVIRONMENT !== "production") return null;
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isPlatformPath(platformPath) || platformPath === "/") {
    return null;
  }

  try {
    const result = await authDatabase.query(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id,
                o.slug,
                o."parentOrganizationId",
                o."tenantId",
                '/' || o.slug AS platform_path,
                true AS path_active,
                0 AS depth
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
         UNION ALL
         SELECT child.id,
                child.slug,
                child."parentOrganizationId",
                child."tenantId",
                platform_tree.platform_path || '/' || child.slug,
                platform_tree.path_active
                  AND EXISTS (
                    SELECT 1
                      FROM subplatform_registrations registration
                     WHERE registration.tenant_id = $1::uuid
                       AND registration.slug = child.slug
                       AND registration.state = 'active'
                  ),
                platform_tree.depth + 1
           FROM "organization" child
           JOIN platform_tree
             ON child."parentOrganizationId" = platform_tree.id
            AND child."tenantId" = platform_tree."tenantId"
          WHERE platform_tree.depth < 64
            AND length(platform_tree.platform_path) < 4_096
       ), active_release AS (
         SELECT tree.platform_path,
                tree.path_active,
                registration.manifest,
                registration.tenant_id AS "tenantId",
                registration.domain_id AS "domainId",
                schema_default.id AS "assetSchemaId",
                market_default.quote_asset_key AS currency,
                market_default.price_scale AS "currencyScale",
                encode(registration.manifest_digest, 'hex') AS "manifestDigest",
                encode(registration.build_digest, 'hex') AS "buildDigest",
                registration.artifact_locator AS "artifactLocator",
                registration.artifact_entry AS "artifactEntry",
                registration.version
           FROM platform_tree tree
           JOIN LATERAL (
             SELECT r.manifest,
                    r.tenant_id,
                    r.domain_id,
                    r.manifest_digest,
                    r.build_digest,
                    r.artifact_locator,
                    r.artifact_entry,
                    r.version
               FROM subplatform_registrations r
              WHERE r.tenant_id = $1::uuid
                AND r.slug = tree.slug
                AND r.state = 'active'
              ORDER BY r.version DESC
              LIMIT 1
           ) registration ON true
           LEFT JOIN LATERAL (
             SELECT s.id
               FROM asset_schemas s
              WHERE s.tenant_id = registration.tenant_id
                AND s.domain_id = registration.domain_id
                AND s.active
              ORDER BY s.schema_version DESC, s.created_at DESC, s.id DESC
              LIMIT 1
           ) schema_default ON true
           LEFT JOIN LATERAL (
             SELECT m.quote_asset_key, m.price_scale
               FROM markets m
              WHERE m.tenant_id = registration.tenant_id
                AND m.domain_id = registration.domain_id
                AND m.status = 'active'
              ORDER BY m.created_at ASC, m.id ASC
              LIMIT 1
           ) market_default ON true
       )
       SELECT manifest, "tenantId", "domainId", "assetSchemaId", currency, "currencyScale",
              "manifestDigest", "buildDigest", "artifactLocator", "artifactEntry", version
         FROM active_release
        WHERE platform_path = $2
          AND path_active
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    const row = result.rows[0] as {
      manifest?: unknown;
      tenantId?: unknown;
      domainId?: unknown;
      assetSchemaId?: unknown;
      currency?: unknown;
      currencyScale?: unknown;
      manifestDigest?: unknown;
      buildDigest?: unknown;
      artifactLocator?: unknown;
      artifactEntry?: unknown;
      version?: unknown;
    } | undefined;
    if (!row || !row.manifest || typeof row.manifest !== "object" || Array.isArray(row.manifest)) return null;
    const sourceAssets = (row.manifest as Record<string, unknown>).assets;
    const assets = sourceAssets && typeof sourceAssets === "object" && !Array.isArray(sourceAssets)
      ? { ...(sourceAssets as Record<string, unknown>) }
      : null;
    const artifactLocator = typeof row.artifactLocator === "string" ? row.artifactLocator : null;
    const artifactEntry = typeof row.artifactEntry === "string" ? row.artifactEntry : "index.html";
    if (artifactLocator && typeof row.buildDigest === "string" && assets) {
      assets.hosted = {
        entry: artifactEntry,
        digest: row.buildDigest,
        url: `/api/platform/plugin-assets${platformPath}/${artifactEntry.split("/").map(encodeURIComponent).join("/")}?path=${encodeURIComponent(platformPath)}&build=${encodeURIComponent(row.buildDigest)}`,
      };
    }
    const manifest = {
      ...(row.manifest as Record<string, unknown>),
      ...(assets ? { assets } : {}),
      tenantId: typeof row.tenantId === "string" ? row.tenantId : undefined,
      domainId: typeof row.domainId === "string" ? row.domainId : undefined,
      assetSchemaId: typeof row.assetSchemaId === "string" ? row.assetSchemaId : undefined,
      currency: typeof row.currency === "string" ? row.currency : undefined,
      currencyScale: Number.isInteger(row.currencyScale) ? row.currencyScale : undefined,
      manifestDigest: typeof row.manifestDigest === "string" ? row.manifestDigest : undefined,
      buildDigest: typeof row.buildDigest === "string" ? row.buildDigest : undefined,
      version: typeof row.version === "number" ? row.version : undefined,
    };
    return JSON.stringify(manifest);
  } catch (error) {
    // A manifest endpoint must fail closed in production. The caller may still
    // use the local static fallback in non-production, but never on a DB error
    // while the deployment claims to be production.
    console.error("active platform manifest lookup failed", error);
    return null;
  }
}

function isPlatformPath(value: string): boolean {
  return /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
