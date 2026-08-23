import { authDatabase } from "./auth";
import { isUuid } from "./uuid";

export { isUuid } from "./uuid";

export interface StoreAccessRow {
  id: string;
  slug: string;
  path: string;
  displayName: string;
  description: string;
  integrationKind: "hosted" | "package" | "external";
  status: "pending" | "active" | "suspended" | "closed";
  version: number;
  domainId: string;
  organizationId: string;
}

export interface StoreAccess {
  store: StoreAccessRow | null;
  canOperate: boolean;
  canManageStore: boolean;
}

export async function readStoreAccess(
  storeId: string,
  userId: string,
  userRole: string | null,
): Promise<StoreAccess> {
  const tenantId = configuredTenantId();
  if (!tenantId)
    return { store: null, canOperate: false, canManageStore: false };
  const result = await authDatabase.query<
    StoreAccessRow & { membershipRole: string | null }
  >(
    `SELECT store.id::text,
            store.slug,
            ('/' || store.slug) AS path,
            store.display_name AS "displayName",
            store.description,
            store.integration_kind AS "integrationKind",
            store.status,
            store.version,
            store.domain_id::text AS "domainId",
            store.organization_id::text AS "organizationId",
            membership.role AS "membershipRole"
       FROM stores store
       LEFT JOIN "member" membership
         ON membership."organizationId" = store.organization_id
        AND membership."userId" = $3::uuid
      WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid`,
    [tenantId, storeId, userId],
  );
  const store = result.rows[0] ?? null;
  const mallOperator =
    userRole === "rootSuperAdmin" || userRole === "rootAdmin";
  const membership = store?.membershipRole?.split(",") ?? [];
  const canOperate =
    mallOperator ||
    membership.some(
      (role) =>
        role === "owner" || role === "admin" || role === "subplatform_admin",
    );
  const canManageStore = mallOperator || membership.includes("owner");
  return { store, canOperate, canManageStore };
}

export function configuredTenantId(): string | null {
  const value = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  return isUuid(value) ? value : null;
}

export function roleOf(user: unknown): string | null {
  return user &&
    typeof user === "object" &&
    "role" in user &&
    typeof (user as { role?: unknown }).role === "string"
    ? (user as { role: string }).role
    : null;
}
