import { authDatabase } from "./lib/auth";
import type { PlatformRouteCandidate } from "./platform-router";
import { isUuid } from "./lib/uuid";

/** Assistant retrieval admits at most this many public stores. */
export const MAX_PUBLIC_STORES = 500;
export const MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT = MAX_PUBLIC_STORES + 1;

export interface ReadPublicStoresOptions {
  limit?: number;
  path?: string;
}

export class PublicStoreDirectoryBudgetExceededError extends Error {
  readonly code = "public_store_directory_budget_exceeded";
  readonly maximum = MAX_PUBLIC_STORES;

  constructor(readonly actual: number) {
    super(
      `public store directory budget exceeded: ${actual} > ${MAX_PUBLIC_STORES}`,
    );
    this.name = "PublicStoreDirectoryBudgetExceededError";
  }
}

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
export async function readPublicStores(
  rootTenantId: string,
  options: ReadPublicStoresOptions = {},
): Promise<PublicStore[]> {
  return readPublicStoresFromDatabase(authDatabase, rootTenantId, options);
}

/** Database reader seam used by the production directory path and PostgreSQL contract tests. */
export async function readPublicStoresFromDatabase(
  database: Pick<typeof authDatabase, "query">,
  rootTenantId: string,
  options: ReadPublicStoresOptions = {},
): Promise<PublicStore[]> {
  const executeQuery = database.query.bind(database);
  const requestedLimit = validatedDirectoryLimit(options.limit);
  const path = validatedDirectoryPath(options.path);
  if (
    path !== undefined &&
    requestedLimit !== undefined &&
    requestedLimit !== 1
  ) {
    throw new RangeError("an exact public store path lookup must use limit 1");
  }
  const limit = path === undefined ? requestedLimit : 1;
  if (!isUuid(rootTenantId)) return [];
  const pathClause =
    path === undefined ? "" : "\n        AND alias.path = $2::text";
  const limitParameter = path === undefined ? 2 : 3;
  const limitClause =
    limit === undefined ? "" : `\n      LIMIT $${limitParameter}::integer`;
  const parameters: Array<string | number> = [rootTenantId];
  if (path !== undefined) parameters.push(path);
  if (limit !== undefined) parameters.push(limit);
  const result = (await executeQuery(
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
        AND registration.tenant_id = store.tenant_id
        AND registration.domain_id = store.domain_id
        AND registration.slug = store.slug
        AND registration.state = 'active'
       LEFT JOIN platform_federation_bindings binding
         ON binding.id = store.federation_binding_id
        AND binding.tenant_id = store.tenant_id
        AND binding.domain_id = store.domain_id
        AND binding.slug = store.slug
        AND binding.organization_id = store.organization_id
        AND binding.registration_id = registration.id
        AND binding.status = 'active'
      WHERE store.tenant_id = $1::uuid${pathClause}
        AND store.status = 'active'
        AND store.visibility = 'public'
        AND (store.integration_kind = 'hosted' OR registration.id IS NOT NULL)
        AND (store.integration_kind <> 'external' OR binding.id IS NOT NULL)
        AND (
          store.integration_kind = 'hosted'
          OR registration.source_kind <> 'remote'
          OR binding.id IS NOT NULL
        )
      ORDER BY store.display_name ASC, store.id ASC${limitClause}`,
    parameters,
  )) as { rows: Record<string, unknown>[] };

  return result.rows.flatMap((row): PublicStore[] => {
    const id = text(row.id);
    const slug = text(row.slug);
    const path = text(row.path);
    const displayName = text(row.displayName);
    const tenantId = text(row.tenantId);
    const domainId = text(row.domainId);
    if (
      !isUuid(id) ||
      !isUuid(tenantId) ||
      !isUuid(domainId) ||
      !isStoreSlug(slug) ||
      path !== `/${slug}` ||
      !displayName
    )
      return [];
    const integrationKind =
      row.integrationKind === "hosted" || row.integrationKind === "external"
        ? row.integrationKind
        : "package";
    return [
      {
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
      },
    ];
  });
}

function validatedDirectoryPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const slug = value.startsWith("/") ? value.slice(1) : "";
  if (value !== `/${slug}` || !isStoreSlug(slug)) {
    throw new RangeError("public store path is invalid");
  }
  return value;
}

function validatedDirectoryLimit(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT
  ) {
    throw new RangeError(
      `public store directory limit must be between 1 and ${MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT}`,
    );
  }
  return value;
}

function boundedFieldKeys(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item): string[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const key = (item as { key?: unknown }).key;
        return typeof key === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(key)
          ? [key]
          : [];
      }),
    ),
  ].slice(0, maximum);
}

export function storeRouteCandidates(
  stores: PublicStore[],
): PlatformRouteCandidate[] {
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
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
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
