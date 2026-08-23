import { auth, authDatabase } from "./lib/auth";
import { hasTrustedBrowserOrigin } from "./lib/request-origin";
import { isUuid } from "./lib/uuid";
export { isUuid };

export interface FederationAdmin {
  userId: string;
  role: "rootSuperAdmin" | "rootAdmin";
  rootTenantId: string;
}

export async function requireFederationAdmin(request: Request): Promise<
  { admin: FederationAdmin; response?: undefined } | { admin?: undefined; response: Response }
> {
  if (!hasTrustedBrowserOrigin(request)) {
    return { response: jsonError("请求来源未被平台信任", 403) };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError("Better Auth session is required", 401) };
  const role = (session.user as { role?: unknown }).role;
  if (role !== "rootSuperAdmin" && role !== "rootAdmin") {
    return { response: jsonError("只有根平台管理员可以管理联邦节点", 403) };
  }
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(rootTenantId)) return { response: jsonError("根平台 tenant 尚未配置", 503) };
  return { admin: { userId: session.user.id, role, rootTenantId } };
}

export async function validateFederationParent(
  tenantId: string,
  parentOrganizationId: string,
  domainId: string,
): Promise<string | null> {
  const result = await authDatabase.query(
    `WITH RECURSIVE chain(id, parent_id, depth, tenant_id, root_platform) AS (
       SELECT id, "parentOrganizationId", 0, "tenantId", "rootPlatform"
         FROM "organization"
        WHERE id = $1::uuid
       UNION ALL
       SELECT parent.id, parent."parentOrganizationId", chain.depth + 1,
              parent."tenantId", parent."rootPlatform"
         FROM "organization" parent
         JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < 64
     )
     SELECT count(*)::int AS count,
            coalesce(max(depth), 0)::int AS depth,
            coalesce(bool_and(tenant_id = $2), false) AS "sameTenant",
            coalesce(bool_or(root_platform AND parent_id IS NULL), false) AS "reachesRoot"
       FROM chain`,
    [parentOrganizationId, tenantId],
  );
  const row = result.rows[0] as {
    count: number;
    depth: number;
    sameTenant: boolean;
    reachesRoot: boolean;
  } | undefined;
  if (!row || row.count === 0) return "parentOrganizationId 不存在或不属于当前 root tenant";
  if (!row.sameTenant) return "parentOrganizationId 与 tenantId 不一致";
  if (row.depth >= 64 || !row.reachesRoot) return "父平台尚未连接到有效根平台";
  const domain = await authDatabase.query(
    `SELECT 1 FROM domains WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active' LIMIT 1`,
    [tenantId, domainId],
  );
  return domain.rowCount === 1 ? null : "domain 不存在、停用或不属于当前 root tenant";
}

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
