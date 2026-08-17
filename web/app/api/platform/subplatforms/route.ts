import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";

const MAX_SOURCE_LOCATOR_LENGTH = 2_048;
const MAX_MANIFEST_BYTES = 64 * 1024;
const allowedScopes = new Set([
  "marketplace:read",
  "marketplace:write",
  "retrieval:query",
  "retrieval:write",
  "platform:read",
]);

/**
 * Root-side registration intake. It records an immutable source/manifest and creates the
 * Better Auth organization in the same request. Fetching and building untrusted package code is
 * intentionally a separate worker concern; a registration is only `validated` until a signed
 * build digest is supplied by that worker.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });

  let input: RegistrationRequest;
  try {
    input = await parseBody(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "子平台注册请求体过大" : "请求必须是有效 JSON" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const manifest = validateManifest(input.manifest, input.slug, input.packageId);
  if (!manifest.ok) return NextResponse.json({ error: manifest.error }, { status: 400 });
  if (!input.tenantId || !isUuid(input.tenantId) || !input.domainId || !isUuid(input.domainId)) {
    return NextResponse.json({ error: "tenantId and domainId must be UUIDs" }, { status: 400 });
  }
  const configuredTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(configuredTenantId) || input.tenantId !== configuredTenantId) {
    return NextResponse.json({ error: "tenantId 必须匹配当前部署的 root tenant" }, { status: 400 });
  }
  if (!isSourceKind(input.sourceKind)) {
    return NextResponse.json({ error: "sourceKind must be git or archive" }, { status: 400 });
  }
  if (input.buildDigest) {
    return NextResponse.json({ error: "buildDigest 只能由隔离构建器回写，注册请求不得自报" }, { status: 400 });
  }
  const sourceError = validateSource(input);
  if (sourceError) return NextResponse.json({ error: sourceError }, { status: 400 });
  if (input.parentOrganizationId && !isUuid(input.parentOrganizationId)) {
    return NextResponse.json({ error: "parentOrganizationId must be a UUID" }, { status: 400 });
  }
  const requestedScopes = normalizeScopes(input.requestedScopes ?? manifest.value.requiredScopes);
  if (!requestedScopes) return NextResponse.json({ error: "requestedScopes contains an unsupported scope" }, { status: 400 });
  const membershipPolicy = input.membershipPolicy ?? "public";
  if (membershipPolicy !== "public" && membershipPolicy !== "invite") {
    return NextResponse.json({ error: "membershipPolicy must be public or invite" }, { status: 400 });
  }

  const requestedParentId = input.parentOrganizationId ?? null;
  // A child registered without an explicit parent belongs to the deployment's root
  // organization.  Never leave it as another top-level node: that would make the recursive
  // router treat a package as a second root.  The root organization is created through the
  // Better Auth bridge, not inferred from a child package.
  const parentId = requestedParentId ?? await readRootOrganizationId(input.tenantId);
  if (!parentId) {
    return NextResponse.json({ error: "请先初始化根平台组织，再登记子平台" }, { status: 409 });
  }
  const userRole = (session.user as { role?: string }).role;
  const canManage = await canManageParent(session.user.id, userRole, parentId);
  if (!canManage) return NextResponse.json({ error: "当前账号没有注册该平台节点的权限" }, { status: 403 });

  const parentError = await validateParent(parentId, input.tenantId);
  if (parentError) return NextResponse.json({ error: parentError }, { status: 400 });
  const domainExists = await authDatabase.query(
    `SELECT 1
       FROM domains
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND status = 'active'
      LIMIT 1`,
    [input.tenantId, input.domainId],
  );
  if (domainExists.rowCount !== 1) {
    return NextResponse.json({ error: "tenantId/domainId 不属于已启用的 root domain" }, { status: 400 });
  }

  const manifestDigest = sha256Hex(canonicalJson(manifest.value));
  const sourceDigest = input.sourceDigest!;
  const registrationId = randomUUID();
  let organization: { id: string; name: string; slug: string };
  try {
    organization = (await auth.api.createOrganization({
      body: {
        name: manifest.value.displayName,
        slug: manifest.value.slug,
        userId: session.user.id,
        metadata: {
          tenantId: input.tenantId,
          domainId: input.domainId,
          packageId: manifest.value.id,
          parentOrganizationId: parentId,
        },
      },
    })) as { id: string; name: string; slug: string };
  } catch (error) {
    console.error("subplatform organization creation failed", error);
    return NextResponse.json({ error: "子平台组织创建失败；slug 可能已被占用" }, { status: 409 });
  }

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const projected = await client.query(
      `UPDATE "organization"
          SET "tenantId" = $2,
              "domainId" = $3,
              "sourceRepository" = $4,
              "parentOrganizationId" = $5,
              "metadata" = $6
        WHERE id = $1::uuid
          AND "rootPlatform" = false
          AND ("tenantId" IS NULL OR "tenantId" = $2)
          AND ("domainId" IS NULL OR "domainId" = $3)
          AND ("parentOrganizationId" IS NULL OR "parentOrganizationId" = $5)
        RETURNING id`,
      [organization.id, input.tenantId, input.domainId, input.sourceLocator, parentId, JSON.stringify({
        packageId: manifest.value.id,
        manifestDigest,
        sourceDigest,
      })],
    );
    if (projected.rowCount !== 1) throw new Error("subplatform organization scope projection returned no row");
    await client.query(
      `INSERT INTO subplatform_registrations
        (id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
         pinned_revision, source_digest, manifest_digest, build_digest, manifest,
         requested_scopes, membership_policy, state, registered_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
               decode($9, 'hex'), decode($10, 'hex'), $11, $12::jsonb, $13, $14, 'validated', $15)`,
      [
        registrationId,
        input.tenantId,
        input.domainId,
        manifest.value.id,
        manifest.value.slug,
        input.sourceKind,
        input.sourceLocator,
        input.pinnedRevision,
        sourceDigest,
        manifestDigest,
        null,
        JSON.stringify(manifest.value),
        requestedScopes,
        membershipPolicy,
        session.user.id,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    await authDatabase.query('DELETE FROM "organization" WHERE id = $1::uuid', [organization.id]).catch(() => undefined);
    console.error("subplatform registration persistence failed", error);
    return NextResponse.json({ error: "子平台注册记录保存失败" }, { status: 500 });
  } finally {
    client?.release();
  }

  return NextResponse.json({
    registrationId,
    organizationId: organization.id,
    slug: organization.slug,
    state: "validated",
    manifestDigest,
    sourceDigest,
    next: "isolated_builder_must_attach_build_digest_before_activation",
  }, { status: 201, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });
  const configuredTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(configuredTenantId)) {
    return NextResponse.json({ error: "root tenant 尚未配置" }, { status: 503 });
  }
  const parentId = new URL(request.url).searchParams.get("parentOrganizationId");
  if (parentId && !isUuid(parentId)) return NextResponse.json({ error: "parentOrganizationId must be a UUID" }, { status: 400 });
  const configuredRootOrganizationId = process.env.MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID?.trim() ?? null;
  const userRole = (session.user as { role?: string }).role;
  if (!(await canManageParent(session.user.id, userRole, parentId || null))) {
    return NextResponse.json({ error: "平台管理员权限不足" }, { status: 403 });
  }
  const rows = await authDatabase.query(
    `WITH RECURSIVE nodes AS (
       SELECT id, name, slug, "parentOrganizationId", "tenantId", "domainId", "sourceRepository", "createdAt"
         FROM "organization"
        WHERE "tenantId" = $2
          AND "rootPlatform" = false
          AND ($3::uuid IS NULL OR id <> $3::uuid)
          AND (($1::uuid IS NULL AND "parentOrganizationId" IS NULL)
           OR id = $1::uuid)
       UNION ALL
       SELECT child.id, child.name, child.slug, child."parentOrganizationId", child."tenantId",
              child."domainId", child."sourceRepository", child."createdAt"
         FROM "organization" child
         JOIN nodes parent ON child."parentOrganizationId" = parent.id
     )
     SELECT nodes.id,
            nodes.name,
            nodes.slug,
            nodes."parentOrganizationId" AS "parentOrganizationId",
            nodes."tenantId" AS "tenantId",
            nodes."domainId" AS "domainId",
            nodes."sourceRepository" AS "sourceRepository",
            nodes."createdAt" AS "createdAt",
            registration.id AS "registrationId",
            registration.state AS "registrationState",
            encode(registration.build_digest, 'hex') AS "buildDigest",
            encode(registration.manifest_digest, 'hex') AS "manifestDigest",
            registration.build_attempts AS "buildAttempts",
            registration.build_error AS "buildError"
       FROM nodes
       LEFT JOIN LATERAL (
         SELECT r.id, r.state, r.build_digest, r.manifest_digest
           FROM subplatform_registrations r
          WHERE r.slug = nodes.slug
            AND r.tenant_id::text = nodes."tenantId"
          ORDER BY r.version DESC
          LIMIT 1
       ) registration ON true
      ORDER BY "createdAt" ASC`,
    [
      parentId || null,
      configuredTenantId,
      configuredRootOrganizationId && isUuid(configuredRootOrganizationId) ? configuredRootOrganizationId : null,
    ],
  );
  return NextResponse.json({ organizations: rows.rows }, { headers: { "cache-control": "no-store" } });
}

interface RegistrationRequest {
  tenantId?: string;
  domainId?: string;
  parentOrganizationId?: string | null;
  packageId?: string;
  slug?: string;
  sourceKind?: "git" | "archive";
  sourceLocator?: string;
  pinnedRevision?: string;
  sourceDigest?: string;
  /** Rejected at the public intake; only the isolated builder may set it. */
  buildDigest?: string;
  manifest?: unknown;
  requestedScopes?: string[];
  membershipPolicy?: "public" | "invite";
}

async function parseBody(request: Request): Promise<RegistrationRequest> {
  const body = await readJsonBody<unknown>(request, 128 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("object required");
  return body as RegistrationRequest;
}

async function canManageParent(userId: string, role: string | null | undefined, parentId: string | null): Promise<boolean> {
  if (!parentId) return role === "rootSuperAdmin" || role === "rootAdmin";
  if (role === "rootSuperAdmin" || role === "rootAdmin") return true;
  const result = await authDatabase.query(
    `SELECT 1 FROM member
      WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid
        AND role = ANY($3::text[])
      LIMIT 1`,
    [parentId, userId, ["owner", "admin", "subplatform_admin"]],
  );
  return result.rowCount === 1;
}

async function validateParent(parentId: string | null, tenantId: string): Promise<string | null> {
  if (!parentId) return null;
  const result = await authDatabase.query(
    `WITH RECURSIVE chain(id, parent_id, depth, tenant_id, root_platform) AS (
       SELECT id, "parentOrganizationId", 0, "tenantId", "rootPlatform"
         FROM "organization"
        WHERE id = $1::uuid
       UNION ALL
       SELECT parent.id, parent."parentOrganizationId", chain.depth + 1, parent."tenantId", parent."rootPlatform"
         FROM "organization" parent JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < 64
     )
     SELECT count(*)::int AS count,
            coalesce(max(depth), 0)::int AS depth,
            coalesce(bool_and(tenant_id = $2), false) AS "sameTenant",
            coalesce(bool_or(root_platform AND parent_id IS NULL), false) AS "reachesRoot"
       FROM chain`,
    [parentId, tenantId],
  );
  const row = result.rows[0] as { count: number; depth: number; sameTenant: boolean; reachesRoot: boolean } | undefined;
  if (!row || row.count === 0) return "parentOrganizationId 不存在";
  if (!row.sameTenant) return "parentOrganizationId 与 tenantId 不一致";
  if (row.depth >= 64) return "平台树深度超过 64 层，可能存在循环关系";
  if (!row.reachesRoot) return "父平台尚未连接到唯一根平台组织";
  return null;
}

async function readRootOrganizationId(tenantId: string): Promise<string | null> {
  const result = await authDatabase.query<{ id: string }>(
    `SELECT id::text
       FROM "organization"
      WHERE "tenantId" = $1
        AND "parentOrganizationId" IS NULL
        AND "rootPlatform" = true
      LIMIT 1`,
    [tenantId],
  );
  return result.rows[0]?.id ?? null;
}

function validateSource(input: RegistrationRequest): string | null {
  const locator = input.sourceLocator?.trim();
  if (!locator || locator.length > MAX_SOURCE_LOCATOR_LENGTH) return "sourceLocator 长度必须为 1..2048";
  const revision = input.pinnedRevision?.trim();
  if (!revision || !/^[0-9a-f]{7,128}$/i.test(revision)) return "pinnedRevision 必须是不可变的 commit/digest";
  if (input.sourceKind === "git") {
    try {
      const url = new URL(locator);
      if (!(url.protocol === "https:" || url.protocol === "ssh:") || url.username || url.password || !url.hostname) {
        return "git sourceLocator 只能使用不带凭据的 HTTPS/SSH URL";
      }
    } catch {
      return "git sourceLocator 不是有效 URL";
    }
  } else if (!input.sourceDigest) {
    return "archive 注册必须提供上传对象的 SHA-256 sourceDigest";
  } else if (!locator.startsWith("upload://") && !locator.startsWith("https://")) {
    return "archive sourceLocator 必须是 upload:// 或 HTTPS 不可变对象地址";
  }
  if (!input.sourceDigest || !/^[0-9a-f]{64}$/i.test(input.sourceDigest)) return "sourceDigest 必须是已验证来源的 SHA-256";
  return null;
}

function validateManifest(value: unknown, slug: string | undefined, packageId: string | undefined):
  | { ok: true; value: Manifest }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "manifest 必须是 JSON 对象" };
  const manifest = value as Partial<Manifest>;
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) return { ok: false, error: "manifest 过大" };
  const unknownKey = Object.keys(manifest).find((key) => !manifestKeys.has(key));
  if (unknownKey) return { ok: false, error: `manifest 包含未声明字段: ${unknownKey}` };
  if (manifest.apiVersion !== "matchplane.subplatform/v1" || manifest.rootApiVersion !== "v1") return { ok: false, error: "manifest API 版本不受支持" };
  if (!stringMatches(manifest.id, /^[a-z0-9][a-z0-9._-]{1,127}$/) || manifest.id !== packageId) return { ok: false, error: "manifest.id 与 packageId 不一致" };
  if (!stringMatches(manifest.slug, /^[a-z0-9][a-z0-9-]{1,62}$/) || manifest.slug === "root" || manifest.slug !== slug) return { ok: false, error: "manifest.slug 与 slug 不一致或使用了保留值" };
  if (!stringMatches(manifest.displayName, /^.{1,200}$/u) || !stringMatches(manifest.entry, /^(?!\/)(?!.*\.\.).+$/)) return { ok: false, error: "manifest displayName/entry 无效" };
  if (manifest.description !== undefined && !stringMatches(manifest.description, /^.{0,2000}$/u)) return { ok: false, error: "manifest.description 无效" };
  if (manifest.marketplaceContract !== undefined
    && manifest.marketplaceContract !== "generic-v1"
    && manifest.marketplaceContract !== "legacy-v1") {
    return { ok: false, error: "manifest.marketplaceContract 无效" };
  }
  if (manifest.pricing !== undefined && !validateManifestPricing(manifest.pricing)) return { ok: false, error: "manifest.pricing 无效" };
  if (manifest.email !== undefined && !validateManifestEmail(manifest.email)) return { ok: false, error: "manifest.email 无效" };
  if (manifest.ui !== undefined && !validateManifestUi(manifest.ui)) return { ok: false, error: "manifest.ui 无效" };
  if (!Array.isArray(manifest.routes)
    || manifest.routes.length === 0
    || manifest.routes[0] !== `/${manifest.slug}`
    || manifest.routes.some((route) => !stringMatches(route, /^\/[a-z0-9][a-z0-9-]*(?:\/.*)?$/))) {
    return { ok: false, error: "manifest.routes 无效，第一条路由必须是 /slug" };
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((item) => !stringMatches(item, /^[a-z0-9_:-]+$/))) return { ok: false, error: "manifest.capabilities 无效" };
  if (!Array.isArray(manifest.requiredScopes) || manifest.requiredScopes.some((item) => !allowedScopes.has(item))) return { ok: false, error: "manifest.requiredScopes 无效" };
  if (!manifest.assets || typeof manifest.assets !== "object" || !stringMatches(manifest.assets.staticDirectory, /^(?!\/)(?!.*\.\.).+$/) || !stringMatches(manifest.assets.buildCommand, /^.{1,500}$/u)) return { ok: false, error: "manifest.assets 无效" };
  if (manifest.agent && !validateAgentManifest(manifest.agent)) return { ok: false, error: "manifest.agent 无效" };
  if (manifest.retrieval && (manifest.retrieval.protocol !== "matchplane.retrieval/v1" || manifest.retrieval.owner !== "subplatform")) return { ok: false, error: "manifest.retrieval 必须声明 subplatform-owned v1" };
  return { ok: true, value: manifest as Manifest };
}

function normalizeScopes(scopes: unknown): string[] | null {
  if (!Array.isArray(scopes) || scopes.length > 32 || scopes.some((scope) => typeof scope !== "string" || !allowedScopes.has(scope))) return null;
  return [...new Set(scopes.filter((scope): scope is string => typeof scope === "string"))];
}

function isSourceKind(value: RegistrationRequest["sourceKind"]): value is "git" | "archive" {
  return value === "git" || value === "archive";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stringMatches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function validateManifestEmail(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const email = value as { providerKey?: unknown; fromAddress?: unknown };
  if (email.providerKey !== undefined && !stringMatches(email.providerKey, /^[a-z0-9][a-z0-9._-]{1,99}$/)) return false;
  if (email.fromAddress !== undefined && !stringMatches(email.fromAddress, /^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return false;
  return true;
}

function validateManifestPricing(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pricing = value as { mode?: unknown; currency?: unknown; currencyScale?: unknown; label?: unknown };
  if (Object.keys(pricing).some((key) => !new Set(["mode", "currency", "currencyScale", "label"]).has(key))) return false;
  if (!["fixed", "range", "negotiable", "none"].includes(String(pricing.mode))) return false;
  if (pricing.currency !== undefined && !stringMatches(pricing.currency, /^[A-Z]{3}$/)) return false;
  if (pricing.currencyScale !== undefined && (!Number.isInteger(pricing.currencyScale) || Number(pricing.currencyScale) < 0 || Number(pricing.currencyScale) > 18)) return false;
  if (pricing.label !== undefined && !stringMatches(pricing.label, /^.{0,120}$/u)) return false;
  if (pricing.mode === "fixed" && !stringMatches(pricing.currency, /^[A-Z]{3}$/)) return false;
  if (pricing.mode === "none" && pricing.currencyScale !== undefined) return false;
  return true;
}

function validateManifestUi(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ui = value as { chat?: unknown; copy?: unknown; filters?: unknown; supplyFields?: unknown; contactFields?: unknown };
  if (Object.keys(ui).some((key) => key !== "chat" && key !== "copy" && key !== "filters" && key !== "supplyFields" && key !== "contactFields")) return false;
  if (ui.chat !== undefined) {
    if (!ui.chat || typeof ui.chat !== "object" || Array.isArray(ui.chat)) return false;
    if (Object.keys(ui.chat).length > 64 || Object.entries(ui.chat).some(([key, item]) =>
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || typeof item !== "string" || item.length > 500)) return false;
  }
  if (ui.copy !== undefined) {
    if (!ui.copy || typeof ui.copy !== "object" || Array.isArray(ui.copy)) return false;
    if (Object.keys(ui.copy).length > 128 || Object.entries(ui.copy).some(([key, item]) =>
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || typeof item !== "string" || item.length > 500)) return false;
  }
  if (ui.filters !== undefined) {
    if (!Array.isArray(ui.filters) || ui.filters.length > 32) return false;
    if (ui.filters.some((filter) => {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
      const item = filter as { key?: unknown; label?: unknown; source?: unknown; attribute?: unknown; value?: unknown };
      return !stringMatches(item.key, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
        || !stringMatches(item.label, /^.{1,200}$/u)
        || !["trust", "price", "attribute"].includes(String(item.source))
        || (item.attribute !== undefined && !stringMatches(item.attribute, /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/))
        || (item.value !== undefined && !stringMatches(item.value, /^.{0,200}$/u));
    })) return false;
  }
  if (ui.supplyFields !== undefined) {
    if (!Array.isArray(ui.supplyFields) || ui.supplyFields.length > 64) return false;
    if (ui.supplyFields.some((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return true;
      const item = field as { key?: unknown; label?: unknown; type?: unknown; required?: unknown; placeholder?: unknown; options?: unknown };
      return !stringMatches(item.key, /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/)
        || !stringMatches(item.label, /^.{1,200}$/u)
        || (item.type !== undefined && !["text", "number", "url", "date", "select"].includes(String(item.type)))
        || (item.required !== undefined && typeof item.required !== "boolean")
        || (item.placeholder !== undefined && !stringMatches(item.placeholder, /^.{0,500}$/u))
        || (item.options !== undefined && (!Array.isArray(item.options) || item.options.length > 64 || item.options.some((option) => !stringMatches(option, /^.{1,200}$/u))));
    })) return false;
  }
  if (ui.contactFields !== undefined) {
    if (!Array.isArray(ui.contactFields) || ui.contactFields.length > 32) return false;
    if (ui.contactFields.some((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return true;
      const item = field as { key?: unknown; label?: unknown; type?: unknown; required?: unknown; placeholder?: unknown };
      return !stringMatches(item.key, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
        || !stringMatches(item.label, /^.{1,200}$/u)
        || (item.type !== undefined && !["text", "tel", "email"].includes(String(item.type)))
        || (item.required !== undefined && typeof item.required !== "boolean")
        || (item.placeholder !== undefined && !stringMatches(item.placeholder, /^.{0,200}$/u));
    })) return false;
  }
  return true;
}

function validateAgentManifest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as { protocol?: unknown; stages?: unknown; skills?: unknown; mcpTools?: unknown; mcpServerKey?: unknown };
  if (Object.keys(agent).some((key) => !new Set(["protocol", "stages", "skills", "mcpTools", "mcpServerKey"]).has(key))) return false;
  if (agent.protocol !== "matchplane.agent/v1") return false;
  if (!Array.isArray(agent.stages)
    || agent.stages.length > 8
    || agent.stages.some((stage) => !stringMatches(stage, /^[a-z0-9][a-z0-9._:-]{1,127}$/))) return false;
  if (!Array.isArray(agent.skills) || agent.skills.length > 32 || agent.skills.some((skill) => !stringMatches(skill, /^[a-z0-9][a-z0-9._:-]{1,127}$/))) return false;
  if (!Array.isArray(agent.mcpTools) || agent.mcpTools.length > 64 || agent.mcpTools.some((tool) => !stringMatches(tool, /^[a-z0-9][a-z0-9._:-]{1,127}$/))) return false;
  if (agent.mcpServerKey !== undefined && !stringMatches(agent.mcpServerKey, /^[a-z0-9][a-z0-9._:-]{1,127}$/)) return false;
  return true;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface Manifest {
  apiVersion: "matchplane.subplatform/v1";
  id: string;
  slug: string;
  displayName: string;
  description?: string;
  marketplaceContract?: "generic-v1" | "legacy-v1";
  pricing?: { mode: "fixed" | "range" | "negotiable" | "none"; currency?: string; currencyScale?: number; label?: string };
  email?: { providerKey?: string; fromAddress?: string };
  ui?: {
    chat?: Record<string, string>;
    copy?: Record<string, string>;
    filters?: Array<{ key: string; label: string; source: "trust" | "price" | "attribute"; attribute?: string; value?: string }>;
    supplyFields?: Array<{ key: string; label: string; type?: string; required?: boolean; placeholder?: string; options?: string[] }>;
    contactFields?: Array<{ key: string; label: string; type?: "text" | "tel" | "email"; required?: boolean; placeholder?: string }>;
  };
  rootApiVersion: "v1";
  entry: string;
  routes: string[];
  capabilities: string[];
  requiredScopes: string[];
  assets: { staticDirectory: string; buildCommand: string };
  agent?: {
    protocol: "matchplane.agent/v1";
    stages: string[];
    skills: string[];
    mcpTools: string[];
    mcpServerKey?: string;
  };
  retrieval?: { protocol: "matchplane.retrieval/v1"; owner: "subplatform" };
  [key: string]: unknown;
}

const manifestKeys = new Set([
  "apiVersion",
  "id",
  "slug",
  "displayName",
  "description",
  "marketplaceContract",
  "pricing",
  "email",
  "ui",
  "rootApiVersion",
  "entry",
  "routes",
  "capabilities",
  "requiredScopes",
  "assets",
  "agent",
  "retrieval",
]);
