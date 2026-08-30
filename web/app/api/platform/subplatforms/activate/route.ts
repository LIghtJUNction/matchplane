import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { isProductionEnvironment } from "../../../../../src/lib/runtime";
import {
  probeSubplatformMcpEndpoint,
  readSubplatformMcpEndpoint,
  validateSubplatformMcpEndpointUrl,
} from "../../../../../src/platform-agent-tool";
import { isUuid } from "../../../../../src/lib/uuid";
import {
  MAX_PRODUCT_TEMPLATES,
  parseProductTemplateCatalog,
  supplyFieldDefinitionsEqual,
  type ProductTemplateCatalog,
  type ProductTemplateConfig,
} from "../../../../../src/product-templates";

export const runtime = "nodejs";

/**
 * Explicitly activates an immutable, built subplatform release. Registration and activation are
 * separate so an untrusted repository can never become routable merely because its manifest was
 * accepted. The build digest must already have been attached by the isolated builder (or supplied
 * during registration) and must match this activation request byte-for-byte.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json(
      { error: "请求来源未被平台信任" },
      { status: 403 },
    );
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return NextResponse.json(
      { error: "Better Auth session is required" },
      { status: 401 },
    );

  let input: ActivationRequest;
  try {
    const value = await readJsonBody<unknown>(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SyntaxError("object required");
    input = value as ActivationRequest;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "激活请求过大"
            : "请求必须是有效 JSON",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!input.registrationId || !isUuid(input.registrationId)) {
    return NextResponse.json(
      { error: "registrationId must be a UUID" },
      { status: 400 },
    );
  }
  if (!input.buildDigest || !/^[0-9a-f]{64}$/i.test(input.buildDigest)) {
    return NextResponse.json(
      { error: "buildDigest must be a SHA-256 digest" },
      { status: 400 },
    );
  }

  const registration = await authDatabase.query(
    `SELECT r.id,
            r.slug,
            r.state,
            r.version::text AS version,
            encode(r.build_digest, 'hex') AS "buildDigest",
            encode(r.manifest_digest, 'hex') AS "manifestDigest",
            r.tenant_id AS "tenantId",
            r.domain_id AS "domainId",
            o.id AS "organizationId",
            o."parentOrganizationId" AS "parentOrganizationId",
            r.manifest AS manifest,
            COALESCE(NULLIF(r.manifest -> 'agent' ->> 'mcpServerKey', ''), r.slug) AS "mcpServerKey"
       FROM subplatform_registrations r
       JOIN "organization" o
         ON o.slug = r.slug AND o."tenantId" = r.tenant_id::text
       JOIN domains d
         ON d.id = r.domain_id
        AND d.tenant_id = r.tenant_id
        AND d.status = 'active'
      WHERE r.id = $1::uuid
      LIMIT 1`,
    [input.registrationId],
  );
  const row = registration.rows[0] as RegistrationRow | undefined;
  if (!row)
    return NextResponse.json(
      { error: "子平台注册记录不存在" },
      { status: 404 },
    );

  const userRole = (session.user as { role?: string }).role;
  if (
    !(await canManageParent(
      session.user.id,
      userRole,
      row.parentOrganizationId,
    ))
  ) {
    return NextResponse.json(
      { error: "当前账号没有激活该平台节点的权限" },
      { status: 403 },
    );
  }
  if (
    row.state !== "active" &&
    !new Set(["validated", "building", "ready"]).has(row.state)
  ) {
    return NextResponse.json(
      { error: `当前状态 ${row.state} 不允许激活` },
      { status: 409 },
    );
  }
  if (row.state !== "active" && !row.buildDigest) {
    return NextResponse.json(
      { error: "隔离构建器尚未附加 buildDigest" },
      { status: 409 },
    );
  }
  if (
    row.state !== "active" &&
    (!row.buildDigest ||
      row.buildDigest.toLowerCase() !== input.buildDigest.toLowerCase())
  ) {
    return NextResponse.json(
      { error: "buildDigest 与已验证构建产物不一致" },
      { status: 409 },
    );
  }

  if (row.state !== "active") {
    const toolHealthError = await validateDeclaredMcpTools(row);
    if (toolHealthError)
      return NextResponse.json({ error: toolHealthError }, { status: 409 });
  }

  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    // `version` is the immutable release ordinal, not an optimistic-lock counter.  Every
    // activation for a tenant/slug therefore shares one transactional lock before it inspects
    // the currently live release.  This avoids a transient duplicate version and prevents a
    // late activation of an old release from suspending the newer storefront projection.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
      [row.tenantId, row.slug],
    );
    const lockedTargetResult = await client.query<RegistrationRow>(
      `SELECT r.id,
              r.slug,
              r.state,
              r.version::text AS version,
              encode(r.build_digest, 'hex') AS "buildDigest",
              encode(r.manifest_digest, 'hex') AS "manifestDigest",
              r.tenant_id AS "tenantId",
              r.domain_id AS "domainId",
              o.id AS "organizationId",
              o."parentOrganizationId" AS "parentOrganizationId",
              r.manifest AS manifest,
              COALESCE(NULLIF(r.manifest -> 'agent' ->> 'mcpServerKey', ''), r.slug) AS "mcpServerKey"
         FROM subplatform_registrations r
         JOIN "organization" o
           ON o.slug = r.slug AND o."tenantId" = r.tenant_id::text
        WHERE r.id = $1::uuid
        FOR UPDATE`,
      [input.registrationId],
    );
    const target = lockedTargetResult.rows[0];
    if (
      !target ||
      target.tenantId !== row.tenantId ||
      target.slug !== row.slug ||
      target.domainId !== row.domainId ||
      target.version !== row.version ||
      target.manifestDigest !== row.manifestDigest
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "注册版本已被其他操作修改，请重新读取后再试" },
        { status: 409 },
      );
    }
    if (target.buildDigest?.toLowerCase() !== input.buildDigest.toLowerCase()) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error:
            target.state === "active"
              ? "已激活版本的 buildDigest 不匹配，不能覆盖不可变发布"
              : "buildDigest 与已验证构建产物不一致",
        },
        { status: 409 },
      );
    }

    const currentActiveResult = await client.query<ActiveRegistration>(
      `SELECT id, version::text AS version, manifest
         FROM subplatform_registrations
        WHERE tenant_id = $1::uuid
          AND slug = $2
          AND domain_id = $3::uuid
          AND state = 'active'
        ORDER BY version DESC
        LIMIT 1
        FOR UPDATE`,
      [target.tenantId, target.slug, target.domainId],
    );
    const currentActive = currentActiveResult.rows[0];
    if (target.state === "active") {
      if (currentActive?.id !== target.id) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "已有更新的注册版本处于激活状态，不能回退覆盖" },
          { status: 409 },
        );
      }
      await enqueueRegistrationCatalogProjections(client, target);
      await client.query("COMMIT");
      return NextResponse.json(toResponse(target), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (
      !new Set(["validated", "building", "ready"]).has(target.state) ||
      !target.buildDigest
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: `当前状态 ${target.state} 不允许激活` },
        { status: 409 },
      );
    }
    if (
      currentActive &&
      compareRegistrationVersion(target.version, currentActive.version) <= 0
    ) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "目标注册版本必须严格新于当前激活版本" },
        { status: 409 },
      );
    }

    const templateStabilityError = await productTemplateStabilityError(
      client,
      target,
      currentActive,
    );
    if (templateStabilityError) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: templateStabilityError },
        { status: 409 },
      );
    }

    const activated = await client.query(
      `UPDATE subplatform_registrations
          SET state = 'active',
              activated_at = COALESCE(activated_at, clock_timestamp())
        WHERE id = $1::uuid
          AND state IN ('validated', 'building', 'ready')
          AND version::text = $2
          AND build_digest = decode($3, 'hex')
        RETURNING id,
                  slug,
                  state,
                  version::text AS version,
                  encode(build_digest, 'hex') AS "buildDigest",
                  encode(manifest_digest, 'hex') AS "manifestDigest",
                  tenant_id AS "tenantId",
                  domain_id AS "domainId",
                  activated_at AS "activatedAt"`,
      [target.id, target.version, input.buildDigest.toLowerCase()],
    );
    if (activated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "注册版本已被其他操作修改，请重新读取后再试" },
        { status: 409 },
      );
    }
    const active = activated.rows[0] as ActivationResponseRow;
    // A slug is one mounted organization path. Once a newer immutable release is active,
    // retire older active rows so routing and child-tool discovery cannot fan out duplicates.
    await client.query(
      `UPDATE subplatform_registrations
          SET state = 'disabled', updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND slug = $2
          AND id <> $3::uuid
          AND state = 'active'
          AND version < $4::bigint`,
      [active.tenantId, active.slug, target.id, target.version],
    );
    await enqueueRegistrationCatalogProjections(client, target);
    await client.query("COMMIT");
    return NextResponse.json(
      {
        ...activated.rows[0],
        routing: "enabled",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("subplatform activation transaction failed", error);
    return NextResponse.json(
      { error: "子平台激活失败，请稍后重试" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}

interface ActivationRequest {
  registrationId?: string;
  buildDigest?: string;
}

interface RegistrationRow {
  id: string;
  slug: string;
  state: string;
  version: string;
  buildDigest: string | null;
  manifestDigest: string;
  tenantId: string;
  domainId: string;
  organizationId: string;
  parentOrganizationId: string | null;
  manifest: unknown;
  mcpServerKey: string;
}

interface ActiveRegistration {
  id: string;
  version: string;
  manifest: unknown;
}

interface LockedStore {
  storeId: string;
}

interface OfferTemplateReference {
  productTemplateId: string | null;
}

interface ActivationResponseRow {
  id: string;
  slug: string;
  state: string;
  version: string;
  buildDigest: string | null;
  manifestDigest: string;
  tenantId: string;
  domainId: string;
  activatedAt?: string | null;
}

/**
 * A package that advertises MCP tools must not become routable in production while its
 * operator-owned endpoint is missing or unable to complete the MCP handshake. Remote federation
 * bindings have their own signed health lifecycle; this check covers packages mounted in the
 * local deployment and deliberately remains opt-in for development so an operator can stage a
 * package before wiring its service.
 */
async function validateDeclaredMcpTools(
  row: RegistrationRow,
): Promise<string | null> {
  if (!isProductionEnvironment()) return null;
  const tools = declaredMcpTools(row.manifest);
  if (!tools.length) return null;
  const endpoint = readSubplatformMcpEndpoint(row.mcpServerKey);
  if (!endpoint) {
    return `子平台已声明 MCP 工具（${tools.slice(0, 3).join(", ")}），但尚未配置 ${row.mcpServerKey} 的 MCP endpoint`;
  }
  if (!(await validateSubplatformMcpEndpointUrl(endpoint.url))) {
    return "子平台 MCP endpoint 未通过生产 DNS/公网地址校验";
  }
  const probe = await probeSubplatformMcpEndpoint({ endpoint });
  if (!probe.ok) {
    return `子平台 MCP endpoint 健康检查失败（HTTP ${probe.status}），暂不能启用已声明工具`;
  }
  return null;
}

async function productTemplateStabilityError(
  client: PoolClient,
  target: RegistrationRow,
  currentActive: ActiveRegistration | undefined,
): Promise<string | null> {
  const storeResult = await client.query<LockedStore>(
    `SELECT id::text AS "storeId"
       FROM stores
      WHERE tenant_id = $1::uuid
        AND domain_id = $2::uuid
        AND organization_id = $3::uuid
      LIMIT 1
      FOR UPDATE`,
    [target.tenantId, target.domainId, target.organizationId],
  );
  const store = storeResult.rows[0];
  if (!store) return null;

  const references = await client.query<OfferTemplateReference>(
    `SELECT product_template_id AS "productTemplateId"
       FROM marketplace_offers
      WHERE tenant_id = $1::uuid
        AND domain_id = $2::uuid
        AND store_id = $3::uuid
      GROUP BY product_template_id
      ORDER BY product_template_id NULLS FIRST
      LIMIT $4`,
    [
      target.tenantId,
      target.domainId,
      store.storeId,
      MAX_PRODUCT_TEMPLATES + 1,
    ],
  );
  if (!references.rows.length) return null;

  const targetCatalog = parseProductTemplateCatalog(target.manifest);
  if (!targetCatalog) return "目标版本的商品模板目录无效，不能安全激活";
  const currentCatalog = currentActive
    ? parseProductTemplateCatalog(currentActive.manifest)
    : null;
  return productTemplateReferenceStabilityError(
    references.rows,
    currentCatalog,
    targetCatalog,
  );
}

function productTemplateReferenceStabilityError(
  references: OfferTemplateReference[],
  currentCatalog: ProductTemplateCatalog | null,
  targetCatalog: ProductTemplateCatalog,
): string | null {
  const hasLegacyReferences = references.some(
    ({ productTemplateId }) => productTemplateId === null,
  );
  const referencedTemplateIds = references.flatMap(({ productTemplateId }) =>
    productTemplateId === null ? [] : [productTemplateId],
  );
  if (hasLegacyReferences && targetCatalog.productTemplates.length > 0) {
    return "店铺仍有未绑定商品模板的历史供给，请先显式迁移后再激活商品模板目录";
  }
  if (
    referencedTemplateIds.length > 0 &&
    targetCatalog.productTemplates.length === 0
  ) {
    return "目标版本不能切回 legacy manifest：店铺供给仍引用商品模板";
  }
  if (!referencedTemplateIds.length) return null;
  if (!currentCatalog) {
    return "当前激活版本无法证明现存商品模板引用的稳定语义";
  }
  return referencedTemplateDefinitionError(
    referencedTemplateIds,
    currentCatalog,
    targetCatalog,
  );
}

function referencedTemplateDefinitionError(
  referencedTemplateIds: string[],
  currentCatalog: ProductTemplateCatalog,
  targetCatalog: ProductTemplateCatalog,
): string | null {
  const currentTemplates = new Map(
    currentCatalog.productTemplates.map((template) => [template.id, template]),
  );
  const targetTemplates = new Map(
    targetCatalog.productTemplates.map((template) => [template.id, template]),
  );
  for (const templateId of referencedTemplateIds) {
    const targetTemplate = targetTemplates.get(templateId);
    if (!targetTemplate) {
      return `目标版本缺少仍被店铺供给引用的商品模板：${templateId}`;
    }
    const currentTemplate = currentTemplates.get(templateId);
    if (!currentTemplate) {
      return `当前激活版本缺少店铺供给已引用的商品模板：${templateId}`;
    }
    if (!sameNormalizedSupplyFields(currentTemplate, targetTemplate)) {
      return `目标版本修改了仍被店铺供给引用的商品模板定义：${templateId}`;
    }
  }
  return null;
}

function sameNormalizedSupplyFields(
  current: ProductTemplateConfig,
  target: ProductTemplateConfig,
): boolean {
  return (
    current.supplyFields.length === target.supplyFields.length &&
    current.supplyFields.every((field, index) => {
      const targetField = target.supplyFields[index];
      return (
        targetField !== undefined &&
        field.key === targetField.key &&
        supplyFieldDefinitionsEqual(field, targetField)
      );
    })
  );
}

async function enqueueRegistrationCatalogProjections(
  client: PoolClient,
  registration: RegistrationRow,
): Promise<void> {
  if (!declaredMcpTools(registration.manifest).includes("catalog.upsert"))
    return;
  await client.query(
    `WITH target AS (
       SELECT offer.tenant_id,
              offer.domain_id,
              offer.store_id,
              offer.id AS offer_id,
              offer.version AS canonical_version,
              alias.path AS platform_path
         FROM stores store
         JOIN marketplace_offers offer
           ON offer.tenant_id = store.tenant_id
          AND offer.domain_id = store.domain_id
          AND offer.store_id = store.id
         JOIN store_path_aliases alias
           ON alias.tenant_id = store.tenant_id
          AND alias.store_id = store.id
          AND alias.is_canonical
        WHERE store.tenant_id = $1::uuid
          AND store.domain_id = $2::uuid
          AND store.current_registration_id = $3::uuid
          AND store.integration_kind <> 'hosted'
     ), superseded AS (
       UPDATE marketplace_offer_projection_jobs job
          SET status = 'superseded',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error_code = NULL,
              last_error = NULL,
              updated_at = clock_timestamp()
         FROM target
        WHERE job.tenant_id = target.tenant_id
          AND job.offer_id = target.offer_id
          AND job.status IN ('pending', 'retry')
          AND job.registration_id IS DISTINCT FROM $3::uuid
       RETURNING job.id
     )
     INSERT INTO marketplace_offer_projection_jobs (
       tenant_id,
       domain_id,
       store_id,
       offer_id,
       canonical_version,
       registration_id,
       platform_path,
       mcp_server_key
     )
     SELECT tenant_id,
            domain_id,
            store_id,
            offer_id,
            canonical_version,
            $3::uuid,
            platform_path,
            $4
       FROM target
     ON CONFLICT (tenant_id, offer_id, canonical_version, registration_id) DO NOTHING`,
    [
      registration.tenantId,
      registration.domainId,
      registration.id,
      registration.mcpServerKey,
    ],
  );
}

function declaredMcpTools(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const agent = (value as { agent?: unknown }).agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return [];
  const tools = (agent as { mcpTools?: unknown }).mcpTools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (tool): tool is string =>
        typeof tool === "string" && /^[a-z0-9][a-z0-9._:-]{1,127}$/.test(tool),
    )
    .slice(0, 64);
}

async function canManageParent(
  userId: string,
  role: string | null | undefined,
  parentId: string | null,
): Promise<boolean> {
  if (!parentId) return role === "rootSuperAdmin" || role === "rootAdmin";
  if (role === "rootSuperAdmin" || role === "rootAdmin") return true;
  const result = await authDatabase.query(
    `SELECT 1
       FROM member
      WHERE "organizationId" = $1::uuid
        AND "userId" = $2::uuid
        AND role = ANY($3::text[])
      LIMIT 1`,
    [parentId, userId, ["owner", "admin", "subplatform_admin"]],
  );
  return result.rowCount === 1;
}

function toResponse(
  row: Pick<
    RegistrationRow,
    | "id"
    | "slug"
    | "state"
    | "buildDigest"
    | "manifestDigest"
    | "tenantId"
    | "domainId"
  >,
): Record<string, unknown> {
  return {
    registrationId: row.id,
    slug: row.slug,
    state: row.state,
    buildDigest: row.buildDigest,
    manifestDigest: row.manifestDigest,
    tenantId: row.tenantId,
    domainId: row.domainId,
    routing: "enabled",
  };
}

function compareRegistrationVersion(left: string, right: string): number {
  try {
    const leftVersion = BigInt(left);
    const rightVersion = BigInt(right);
    return leftVersion === rightVersion
      ? 0
      : leftVersion < rightVersion
        ? -1
        : 1;
  } catch {
    // The database constrains versions to positive bigint values. Treat an unexpectedly malformed
    // row as non-activatable rather than accepting a potentially stale release.
    return -1;
  }
}
