import { authDatabase } from "./lib/auth";
import type { PlatformRouteCandidate } from "./platform-router";

export interface PublicStore {
  id: string;
  slug: string;
  path: string;
  displayName: string;
  description: string;
  integrationKind: "hosted" | "package" | "external";
  capabilities: string[];
  agentStages: string[];
  agentSkills: string[];
  publicFields?: string[];
  tenantId: string;
  domainId: string;
}

/**
 * Read the flat, public store directory.  This is the commercial boundary used by the mall;
 * Better Auth's historical organization tree remains an authorization compatibility detail.
 */
export async function readPublicStores(rootTenantId: string): Promise<PublicStore[]> {
  if (!isUuid(rootTenantId)) return [];
  const result = await authDatabase.query(
    `SELECT store.id::text,
            store.slug,
            alias.path,
            store.display_name AS "displayName",
            store.description,
            store.integration_kind AS "integrationKind",
            store.tenant_id::text AS "tenantId",
            store.domain_id::text AS "domainId",
            COALESCE(registration.manifest -> 'capabilities', '[]'::jsonb) AS capabilities,
            COALESCE(registration.manifest -> 'agent' -> 'stages', '[]'::jsonb) AS "agentStages",
            COALESCE(registration.manifest -> 'agent' -> 'skills', '[]'::jsonb) AS "agentSkills"
            ,COALESCE(registration.manifest -> 'ui' -> 'supplyFields', '[]'::jsonb) AS "publicFields"
       FROM stores store
       JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical = true
       JOIN domains domain
         ON domain.tenant_id = store.tenant_id
        AND domain.id = store.domain_id
        AND domain.status = 'active'
       LEFT JOIN subplatform_registrations registration
         ON registration.id = store.current_registration_id
      WHERE store.tenant_id = $1::uuid
        AND store.status = 'active'
        AND store.visibility = 'public'
        AND (
          store.integration_kind = 'hosted'
          OR (registration.id IS NOT NULL AND registration.state = 'active')
        )
        AND (
          store.integration_kind <> 'external'
          OR EXISTS (
            SELECT 1
              FROM platform_federation_bindings binding
             WHERE binding.id = store.federation_binding_id
               AND binding.status = 'active'
          )
        )
      ORDER BY store.display_name ASC, store.id ASC`,
    [rootTenantId],
  );

  return result.rows.flatMap((row): PublicStore[] => {
    const id = text(row.id);
    const slug = text(row.slug);
    const path = text(row.path);
    const displayName = text(row.displayName);
    const tenantId = text(row.tenantId);
    const domainId = text(row.domainId);
    if (!isUuid(id) || !isUuid(tenantId) || !isUuid(domainId) || !isStoreSlug(slug) || path !== `/${slug}` || !displayName) return [];
    const integrationKind = row.integrationKind === "hosted" || row.integrationKind === "external"
      ? row.integrationKind
      : "package";
    return [{
      id,
      slug,
      path,
      displayName,
      description: text(row.description).slice(0, 2_000),
      integrationKind,
      capabilities: boundedStrings(row.capabilities, 64),
      agentStages: boundedStrings(row.agentStages, 8),
      agentSkills: boundedStrings(row.agentSkills, 32),
      publicFields: boundedFieldKeys(row.publicFields, 32),
      tenantId,
      domainId,
    }];
  });
}

function boundedFieldKeys(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item): string[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const key = (item as { key?: unknown }).key;
    return typeof key === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(key) ? [key] : [];
  }))].slice(0, maximum);
}

export function storeRouteCandidates(stores: PublicStore[]): PlatformRouteCandidate[] {
  return stores.map((store) => ({
    slug: store.slug,
    path: store.path,
    tenantId: store.tenantId,
    domainId: store.domainId,
    displayName: store.displayName,
    description: store.description,
    capabilities: store.capabilities,
    agentStages: store.agentStages,
    agentSkills: store.agentSkills,
    depth: 1,
  }));
}

function boundedStrings(value: unknown, maximum: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, maximum)
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isStoreSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
