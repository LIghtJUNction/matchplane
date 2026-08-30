import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../../src/lib/auth";
import {
  isUuid,
  jsonError,
  requireFederationAdmin,
  validateFederationParent,
} from "../../../../../../src/federation-admin";
import { validateFederationTokenEnv } from "../../../../../../src/federation-contract";
import {
  prepareSubplatformMcpEndpoint,
  probeSubplatformMcpEndpoint,
  validateSubplatformMcpEndpointUrl,
} from "../../../../../../src/platform-agent-tool";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../../src/lib/body-limit";
import { isProductionEnvironment } from "../../../../../../src/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Activate a previously signed remote node as a routable, MCP-backed platform child. */
export async function POST(request: Request): Promise<Response> {
  const guard = await requireFederationAdmin(request);
  if (guard.response) return guard.response;
  let body: ActivateRequest;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object required");
    body = value as ActivateRequest;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "联邦激活请求过大" : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (!isUuid(body.bindingId)) return jsonError("bindingId 必须是 UUID", 400);
  const tokenEnv = body.tokenEnv === undefined || body.tokenEnv === null || body.tokenEnv === ""
    ? null
    : validateFederationTokenEnv(body.tokenEnv);
  if (body.tokenEnv !== undefined && body.tokenEnv !== null && body.tokenEnv !== "" && !tokenEnv) {
    return jsonError("tokenEnv 必须是大写环境变量名", 400);
  }
  if (isProductionEnvironment() && !tokenEnv) {
    return jsonError("生产环境必须配置 remote MCP bearer token 的 tokenEnv", 400);
  }
  // A tokenEnv name alone is not a credential. Fail closed before creating an active
  // registration; otherwise the child would be advertised in routing while every MCP call
  // is guaranteed to have no Authorization header.
  if (tokenEnv && !process.env[tokenEnv]?.trim()) {
    return jsonError(`联邦 MCP 凭据 ${tokenEnv} 尚未注入当前服务`, 409);
  }
  const membershipPolicy = body.membershipPolicy === "public" ? "public" : "invite";

  const result = await authDatabase.query<BindingRecord>(
    `SELECT id::text, tenant_id::text AS "tenantId", domain_id::text AS "domainId",
            parent_organization_id::text AS "parentOrganizationId", organization_id::text AS "organizationId",
            registration_id::text AS "registrationId", node_id::text AS "nodeId", slug, display_name AS "displayName",
            endpoint, mcp_server_key AS "mcpServerKey", public_key AS "publicKey", manifest,
            encode(manifest_digest, 'hex') AS "manifestDigest", signature, status
       FROM platform_federation_bindings
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    [body.bindingId, guard.admin.rootTenantId],
  );
  const binding = result.rows[0];
  if (!binding) return jsonError("联邦绑定不存在", 404);
  if (binding.status === "revoked") return jsonError("已撤销的联邦绑定不能重新激活，请重新发邀请", 409);
  if (!(await validateSubplatformMcpEndpointUrl(binding.endpoint))) {
    return jsonError("联邦 MCP endpoint 未通过生产 DNS/公网地址校验", 409);
  }
  if (isProductionEnvironment() && !binding.registrationId) {
    // Do not create an active organization/registration until the remote MCP server has
    // completed the same initialize handshake used by the explicit health action. A URL and
    // tokenEnv only prove configuration, not that the remote node is reachable or speaks the
    // advertised protocol.
    const endpoint = await prepareSubplatformMcpEndpoint({
      serverKey: binding.mcpServerKey,
      url: binding.endpoint,
      tokenEnv,
    });
    if (!endpoint) return jsonError("联邦 MCP endpoint 或凭据尚未准备好", 409);
    const probe = await probeSubplatformMcpEndpoint({ endpoint });
    if (!probe.ok) {
      return jsonError(`联邦 MCP initialize 未成功（${probe.error ?? `HTTP ${probe.status}`}）`, 409);
    }
  }
  if (binding.organizationId) {
    const organization = await authDatabase.query<OrganizationOwnership>(
      `SELECT id::text, slug, "tenantId" AS "tenantId", "domainId" AS "domainId",
              "parentOrganizationId"::text AS "parentOrganizationId", "rootPlatform" AS "rootPlatform"
         FROM "organization"
        WHERE id = $1::uuid
        LIMIT 1`,
      [binding.organizationId],
    );
    const ownedOrganization = organization.rows[0];
    if (
      !ownedOrganization
      || ownedOrganization.slug !== binding.slug
      || ownedOrganization.rootPlatform
      || (ownedOrganization.tenantId !== null && ownedOrganization.tenantId !== binding.tenantId)
      || (ownedOrganization.domainId !== null && ownedOrganization.domainId !== binding.domainId)
      || (ownedOrganization.parentOrganizationId !== null
        && ownedOrganization.parentOrganizationId !== binding.parentOrganizationId)
    ) {
      return jsonError("联邦绑定关联的组织不属于当前租户或父平台", 409);
    }
    const projected = await authDatabase.query(
      `UPDATE "organization"
          SET "tenantId" = $2,
              "domainId" = $3,
              "sourceRepository" = $4,
              "parentOrganizationId" = $5::uuid
        WHERE id = $1::uuid
          AND "rootPlatform" = false
          AND ("tenantId" IS NULL OR "tenantId" = $2)
          AND ("domainId" IS NULL OR "domainId" = $3)
          AND ("parentOrganizationId" IS NULL OR "parentOrganizationId" = $5::uuid)`,
      [binding.organizationId, binding.tenantId, binding.domainId, binding.endpoint, binding.parentOrganizationId],
    );
    if (projected.rowCount !== 1) return jsonError("联邦绑定组织投影失败，请检查租户与父平台归属", 409);
  }
  if (binding.registrationId) {
    if (!binding.organizationId) return jsonError("联邦绑定缺少组织投影，不能宣称已启用路由", 409);
    if (binding.status === "degraded") {
      return jsonError("联邦 MCP 当前健康检查失败，请检查服务后重新执行健康检查", 409);
    }
    if (binding.status !== "active") {
      return jsonError("联邦绑定尚未通过健康检查，不能启用路由", 409);
    }
    return NextResponse.json({
      bindingId: binding.id,
      registrationId: binding.registrationId,
      organizationId: binding.organizationId,
      slug: binding.slug,
      status: "active",
      routing: "enabled",
    }, { headers: { "cache-control": "no-store" } });
  }
  const parentError = await validateFederationParent(binding.tenantId, binding.parentOrganizationId, binding.domainId);
  if (parentError) return jsonError(parentError, 409);

  let organizationId = binding.organizationId;
  if (!organizationId) {
    try {
      const created = await auth.api.createOrganization({
        body: {
          name: binding.displayName,
          slug: binding.slug,
          userId: guard.admin.userId,
          metadata: {
            tenantId: binding.tenantId,
            domainId: binding.domainId,
            parentOrganizationId: binding.parentOrganizationId,
            federationBindingId: binding.id,
            federationNodeId: binding.nodeId,
          },
        },
      });
      const createdId = (created as { id?: unknown }).id;
      if (!isUuid(createdId)) return jsonError("Better Auth 未返回有效组织 ID", 502);
      organizationId = createdId;
      const linked = await authDatabase.query(
        `UPDATE platform_federation_bindings
            SET organization_id = $2::uuid, updated_at = clock_timestamp()
          WHERE id = $1::uuid AND organization_id IS NULL`,
        [binding.id, organizationId],
      );
      if (linked.rowCount !== 1) return jsonError("联邦绑定在激活期间已被其他请求占用", 409);
    } catch (error) {
      console.error("federated organization creation failed", error);
      return jsonError("远程平台组织创建失败；slug 可能已被占用", 409);
    }
  }

  const registrationId = binding.registrationId ?? randomUUID();
  const manifest = binding.manifest && typeof binding.manifest === "object" && !Array.isArray(binding.manifest)
    ? binding.manifest as Record<string, unknown>
    : null;
  if (!manifest) return jsonError("联邦绑定清单已损坏", 500);
  const requiredScopes = Array.isArray(manifest.requiredScopes)
    ? manifest.requiredScopes.filter((item): item is string => typeof item === "string").slice(0, 32)
    : [];
  if (!organizationId) return jsonError("联邦绑定缺少 Better Auth 组织", 409);
  // Better Auth's additional fields are input:false, so metadata supplied during creation is not
  // the routing projection. Fill the durable tenant/domain/parent columns before inserting the
  // registration; otherwise the first activation would return success but remain invisible to
  // the recursive child-route query until a second retry.
  const projected = await authDatabase.query(
    `UPDATE "organization"
        SET "tenantId" = $2,
            "domainId" = $3,
            "sourceRepository" = $4,
            "parentOrganizationId" = $5::uuid
      WHERE id = $1::uuid
        AND slug = $6
        AND "rootPlatform" = false
        AND ("tenantId" IS NULL OR "tenantId" = $2)
        AND ("domainId" IS NULL OR "domainId" = $3)
        AND ("parentOrganizationId" IS NULL OR "parentOrganizationId" = $5::uuid)
      RETURNING id::text`,
    [organizationId, binding.tenantId, binding.domainId, binding.endpoint, binding.parentOrganizationId, binding.slug],
  );
  if (projected.rowCount !== 1) return jsonError("联邦绑定组织不属于当前租户或父平台", 409);
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    // The endpoint probe runs before the transaction. Lock and re-read the binding so a
    // concurrent revoke or failed health check cannot be overwritten by this stale success.
    const lockedBindingResult = await client.query<{ status: string }>(
      `SELECT status
         FROM platform_federation_bindings
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        FOR UPDATE`,
      [binding.id, binding.tenantId],
    );
    const lockedBinding = lockedBindingResult.rows[0];
    if (!lockedBinding || lockedBinding.status === "revoked") {
      await client.query("ROLLBACK");
      return jsonError("联邦绑定已在激活期间撤销", 409);
    }
    if (lockedBinding.status === "degraded") {
      await client.query("ROLLBACK");
      return jsonError("联邦 MCP 健康状态已在激活期间降级，请重新执行健康检查", 409);
    }
    if (lockedBinding.status !== "pending" && lockedBinding.status !== "active") {
      await client.query("ROLLBACK");
      return jsonError("联邦绑定状态不允许激活", 409);
    }
    const existing = await client.query<{ id: string; state: string }>(
    `SELECT id::text, state
         FROM subplatform_registrations
        WHERE federation_binding_id = $1::uuid OR (tenant_id = $2::uuid AND slug = $3 AND source_kind = 'remote')
        ORDER BY version DESC
        LIMIT 1
        FOR UPDATE`,
      [binding.id, binding.tenantId, binding.slug],
    );
    if (existing.rows[0]?.id) {
      if (existing.rows[0].state !== "active") {
        await client.query("ROLLBACK");
        return jsonError("联邦注册版本尚未处于 active，不能启用路由", 409);
      }
      // A health probe deliberately moves a binding to degraded and the child-route query
      // excludes it. Do not let an operator retry the activation form and silently bypass that
      // isolation without a successful explicit health check.
      const activatedBinding = await client.query(
        `UPDATE platform_federation_bindings
            SET organization_id = $2::uuid, registration_id = $3::uuid, status = 'active',
                token_env = $4, activated_by = $5, activated_at = COALESCE(activated_at, clock_timestamp()),
                updated_at = clock_timestamp()
          WHERE id = $1::uuid AND status IN ('pending', 'active')`,
        [binding.id, organizationId, existing.rows[0].id, tokenEnv, guard.admin.userId],
      );
      if (activatedBinding.rowCount !== 1) {
        await client.query("ROLLBACK");
        return jsonError("联邦绑定状态已在激活期间改变", 409);
      }
      await client.query("COMMIT");
      return NextResponse.json({
        bindingId: binding.id,
        registrationId: existing.rows[0].id,
        organizationId,
        slug: binding.slug,
        status: "active",
        routing: "enabled",
      }, { headers: { "cache-control": "no-store" } });
    }

    await client.query(
      `UPDATE "organization"
          SET "tenantId" = $2,
              "domainId" = $3,
              "sourceRepository" = $4,
              "parentOrganizationId" = $5,
              "metadata" = $6
        WHERE id = $1::uuid
          AND "tenantId" = $2`,
      [organizationId, binding.tenantId, binding.domainId, binding.endpoint, binding.parentOrganizationId, JSON.stringify({
        federationBindingId: binding.id,
        federationNodeId: binding.nodeId,
        manifestDigest: binding.manifestDigest,
      })],
    );
    await client.query(
      `INSERT INTO subplatform_registrations
        (id, federation_binding_id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
         pinned_revision, source_digest, manifest_digest, manifest, requested_scopes, membership_policy,
         state, registered_by, activated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'remote', $7, $8,
               decode($9, 'hex'), decode($9, 'hex'), $10::jsonb, $11, $12, 'active', $13, clock_timestamp())`,
      [
        registrationId,
        binding.id,
        binding.tenantId,
        binding.domainId,
        `federated.${binding.nodeId.replaceAll("-", "")}`,
        binding.slug,
        `federation://${binding.id}`,
        binding.manifestDigest,
        binding.manifestDigest,
        JSON.stringify(manifest),
        requiredScopes,
        membershipPolicy,
        guard.admin.userId,
      ],
    );
    const activatedBinding = await client.query(
      `UPDATE platform_federation_bindings
          SET organization_id = $2::uuid, registration_id = $3::uuid, status = 'active',
              token_env = $4, activated_by = $5, activated_at = COALESCE(activated_at, clock_timestamp()),
              updated_at = clock_timestamp()
        WHERE id = $1::uuid AND status IN ('pending', 'active')`,
      [binding.id, organizationId, registrationId, tokenEnv, guard.admin.userId],
    );
    if (activatedBinding.rowCount !== 1) {
      await client.query("ROLLBACK");
      return jsonError("联邦绑定状态已在激活期间改变", 409);
    }
    await client.query("COMMIT");
    return NextResponse.json({
      bindingId: binding.id,
      registrationId,
      organizationId,
      slug: binding.slug,
      status: "active",
      routing: "enabled",
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("federated binding activation failed", error);
    return jsonError("联邦绑定激活失败；请检查组织、domain 和清单是否仍然有效", 409);
  } finally {
    client.release();
  }
}

interface ActivateRequest {
  bindingId?: unknown;
  tokenEnv?: unknown;
  membershipPolicy?: unknown;
}

interface BindingRecord {
  id: string;
  tenantId: string;
  domainId: string;
  parentOrganizationId: string;
  organizationId: string | null;
  registrationId: string | null;
  nodeId: string;
  slug: string;
  displayName: string;
  endpoint: string;
  mcpServerKey: string;
  publicKey: string;
  manifest: unknown;
  manifestDigest: string;
  signature: string;
  status: string;
}

interface OrganizationOwnership {
  id: string;
  slug: string;
  tenantId: string | null;
  domainId: string | null;
  parentOrganizationId: string | null;
  rootPlatform: boolean;
}
