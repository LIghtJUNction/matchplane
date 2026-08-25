import { authDatabase } from "./lib/auth";
import { isProductionEnvironment } from "./lib/runtime";
import { isUuid } from "./lib/uuid";

/**
 * Read the active store manifest. Native hosted stores use a small marketplace-owned manifest;
 * package and external stores keep the immutable v1 manifest compatibility path.
 *
 * A package checked into `public/` is useful for local development, but it is
 * not an activation grant in production. The database record is the source of
 * truth so a dynamically registered child (including a grandchild) receives
 * the same manifest path as the routing Agent.
 *
 * A hosted store has no `public/` package: its manifest (display name, description,
 * status) lives only in the database, so that lookup runs in every environment.
 */
export async function readActivePlatformManifest(platformPath: string): Promise<string | null> {
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId) || !isPlatformPath(platformPath) || platformPath === "/") {
    return null;
  }

  try {
    const hosted = await authDatabase.query(
      `SELECT store.id::text,
              store.organization_id::text AS "organizationId",
              store.tenant_id::text AS "tenantId",
              store.domain_id::text AS "domainId",
              store.slug,
              store.display_name AS "displayName",
              store.description,
              store.status,
              store.version::text
         FROM stores store
         JOIN store_path_aliases alias
           ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id
         JOIN domains domain
           ON domain.tenant_id = store.tenant_id AND domain.id = store.domain_id AND domain.status = 'active'
        WHERE store.tenant_id = $1::uuid
          AND alias.path = $2
          AND store.integration_kind = 'hosted'
          AND store.status IN ('active', 'closed', 'suspended', 'pending')
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    const hostedStore = hosted.rows[0] as Record<string, unknown> | undefined;
    if (hostedStore) {
      return JSON.stringify({
        apiVersion: "matchplane.subplatform/v1",
        id: `hosted.${String(hostedStore.id)}`,
        slug: hostedStore.slug,
        displayName: hostedStore.displayName,
        description: hostedStore.description,
        status: hostedStore.status,
        marketplaceContract: "generic-v1",
        pricing: { mode: "fixed", currency: "CNY", currencyScale: 2, label: "价格" },
        rootApiVersion: "v1",
        routes: [platformPath],
        capabilities: ["demand", "supply", "public_catalog"],
        requiredScopes: ["marketplace:read", "marketplace:write"],
        organizationId: hostedStore.organizationId,
        tenantId: hostedStore.tenantId,
        domainId: hostedStore.domainId,
        version: Number(hostedStore.version),
      });
    }

    const projection = await authDatabase.query<{ integrationKind: string }>(
      `SELECT store.integration_kind AS "integrationKind"
         FROM store_path_aliases alias
         JOIN stores store
           ON store.tenant_id = alias.tenant_id
          AND store.id = alias.store_id
        WHERE alias.tenant_id = $1::uuid
          AND alias.path = $2
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    const projectedStore = projection.rows[0];
    // An inactive hosted projection was not returned above. It must not fall back to the old
    // registration tree. Package/external projections are resolved only through their exact
    // current_registration_id below.
    if (projectedStore?.integrationKind === "hosted") return null;

    // Package/external registrations are production activation grants; development keeps
    // the static `public/` package manifest fallback owned by the manifest routes.
    if (!isProductionEnvironment()) return null;

    const result = projectedStore
      ? await authDatabase.query(
        `SELECT registration.manifest,
                store.organization_id::text AS "organizationId",
                registration.tenant_id::text AS "tenantId",
                registration.domain_id::text AS "domainId",
                store.status,
                schema_default.id AS "assetSchemaId",
                schema_default.schema_document AS "assetSchema",
                market_default.quote_asset_key AS currency,
                market_default.price_scale AS "currencyScale",
                encode(registration.manifest_digest, 'hex') AS "manifestDigest",
                encode(registration.build_digest, 'hex') AS "buildDigest",
                registration.artifact_locator AS "artifactLocator",
                registration.artifact_entry AS "artifactEntry",
                registration.version
           FROM stores store
           JOIN store_path_aliases alias
             ON alias.tenant_id = store.tenant_id
            AND alias.store_id = store.id
           JOIN domains domain
             ON domain.tenant_id = store.tenant_id
            AND domain.id = store.domain_id
            AND domain.status = 'active'
           JOIN subplatform_registrations registration
             ON registration.id = store.current_registration_id
            AND registration.tenant_id = store.tenant_id
            AND registration.domain_id = store.domain_id
            AND registration.state = 'active'
           LEFT JOIN LATERAL (
             SELECT s.id, s.schema_document
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
          WHERE store.tenant_id = $1::uuid
            AND alias.path = $2
            AND store.status IN ('active', 'closed', 'suspended', 'pending')
            AND store.integration_kind IN ('package', 'external')
            AND (store.integration_kind <> 'external' OR EXISTS (
              SELECT 1
                FROM platform_federation_bindings binding
               WHERE binding.id = store.federation_binding_id
                 AND binding.tenant_id = store.tenant_id
                 AND binding.domain_id = store.domain_id
                 AND binding.status = 'active'
            ))
          LIMIT 1`,
        [rootTenantId, platformPath],
      )
      : await authDatabase.query(
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
       ), active_release AS (
         SELECT tree.platform_path,
                tree.id AS "organizationId",
                tree.path_active,
                registration.manifest,
                registration.tenant_id AS "tenantId",
                registration.domain_id AS "domainId",
                schema_default.id AS "assetSchemaId",
                schema_default.schema_document AS "assetSchema",
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
           LEFT JOIN LATERAL (
             SELECT s.id, s.schema_document
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
       SELECT manifest, "organizationId", "tenantId", "domainId", "assetSchemaId", "assetSchema", currency, "currencyScale",
              "manifestDigest", "buildDigest", "artifactLocator", "artifactEntry", version
         FROM active_release
        WHERE platform_path = $2
          AND path_active
        LIMIT 1`,
        [rootTenantId, platformPath],
      );
    const row = result.rows[0] as {
      manifest?: unknown;
      organizationId?: unknown;
      tenantId?: unknown;
      domainId?: unknown;
      status?: unknown;
      assetSchemaId?: unknown;
      assetSchema?: unknown;
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
      status: typeof row.status === "string" ? row.status : "active",
      organizationId: typeof row.organizationId === "string" ? row.organizationId : undefined,
      tenantId: typeof row.tenantId === "string" ? row.tenantId : undefined,
      domainId: typeof row.domainId === "string" ? row.domainId : undefined,
      assetSchemaId: typeof row.assetSchemaId === "string" ? row.assetSchemaId : undefined,
      assetSchema: row.assetSchema && typeof row.assetSchema === "object" && !Array.isArray(row.assetSchema) ? row.assetSchema : undefined,
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
