import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { isUuid } from "../../../../src/lib/uuid";
import { validateManifestUi } from "../../../../src/manifest-ui-validation";

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

  let input: RegistrationRequest;
  try {
    input = await parseBody(request);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "子平台注册请求体过大"
            : "请求必须是有效 JSON",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const manifest = validateManifest(
    input.manifest,
    input.slug,
    input.packageId,
  );
  if (!manifest.ok)
    return NextResponse.json({ error: manifest.error }, { status: 400 });
  if (
    !input.tenantId ||
    !isUuid(input.tenantId) ||
    !input.domainId ||
    !isUuid(input.domainId)
  ) {
    return NextResponse.json(
      { error: "tenantId and domainId must be UUIDs" },
      { status: 400 },
    );
  }
  const configuredTenantId =
    process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(configuredTenantId) || input.tenantId !== configuredTenantId) {
    return NextResponse.json(
      { error: "tenantId 必须匹配当前部署的 root tenant" },
      { status: 400 },
    );
  }
  if (!isSourceKind(input.sourceKind)) {
    return NextResponse.json(
      { error: "sourceKind must be git or archive" },
      { status: 400 },
    );
  }
  if (input.buildDigest) {
    return NextResponse.json(
      { error: "buildDigest 只能由隔离构建器回写，注册请求不得自报" },
      { status: 400 },
    );
  }
  const sourceError = validateSource(input);
  if (sourceError)
    return NextResponse.json({ error: sourceError }, { status: 400 });
  if (input.parentOrganizationId && !isUuid(input.parentOrganizationId)) {
    return NextResponse.json(
      { error: "parentOrganizationId must be a UUID" },
      { status: 400 },
    );
  }
  const requestedScopes = normalizeScopes(
    input.requestedScopes ?? manifest.value.requiredScopes,
  );
  if (!requestedScopes)
    return NextResponse.json(
      { error: "requestedScopes contains an unsupported scope" },
      { status: 400 },
    );
  const membershipPolicy = input.membershipPolicy ?? "public";
  if (membershipPolicy !== "public" && membershipPolicy !== "invite") {
    return NextResponse.json(
      { error: "membershipPolicy must be public or invite" },
      { status: 400 },
    );
  }

  const requestedParentId = input.parentOrganizationId ?? null;
  const parentId = await readRootOrganizationId(input.tenantId);
  if (!parentId) {
    return NextResponse.json(
      { error: "商城初始化完成后即可接入店铺" },
      { status: 409 },
    );
  }
  if (requestedParentId && requestedParentId !== parentId) {
    return NextResponse.json(
      { error: "店铺只能直接接入商城，不能嵌套在其他店铺中" },
      { status: 400 },
    );
  }
  const userRole = (session.user as { role?: string }).role;
  const canManage = await canManageParent(session.user.id, userRole, parentId);
  if (!canManage)
    return NextResponse.json(
      { error: "当前账号没有注册该平台节点的权限" },
      { status: 403 },
    );

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
    return NextResponse.json(
      { error: "tenantId/domainId 不属于已启用的 root domain" },
      { status: 400 },
    );
  }

  const manifestDigest = sha256Hex(canonicalJson(manifest.value));
  const sourceDigest = input.sourceDigest!;
  const registrationId = randomUUID();
  let organization: { id: string; name: string; slug: string };
  let organizationCreated = false;
  const existingOrganization = await authDatabase.query<{
    id: string;
    name: string;
    slug: string;
  }>(
    `SELECT id::text, name, slug
       FROM "organization"
      WHERE slug = $1
        AND "tenantId" = $2
        AND "parentOrganizationId" = $3::uuid
        AND "rootPlatform" = false
      LIMIT 1`,
    [manifest.value.slug, input.tenantId, parentId],
  );
  if (existingOrganization.rows[0]) {
    // A subplatform slug identifies a stable organization node. Reuse that node for an
    // immutable registration upgrade instead of creating a second Better Auth organization.
    organization = existingOrganization.rows[0];
  } else {
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
      organizationCreated = true;
    } catch (error) {
      console.error("subplatform organization creation failed", error);
      return NextResponse.json(
        { error: "子平台组织创建失败；slug 可能已被占用" },
        { status: 409 },
      );
    }
  }

  let client: PoolClient | undefined;
  let version = "1";
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const nextVersion = await client.query<{ version: string }>(
      `SELECT (COALESCE(MAX(version), 0) + 1)::text AS version
         FROM subplatform_registrations
        WHERE tenant_id = $1::uuid AND slug = $2`,
      [input.tenantId, manifest.value.slug],
    );
    version = nextVersion.rows[0]?.version ?? "1";
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
      [
        organization.id,
        input.tenantId,
        input.domainId,
        input.sourceLocator,
        parentId,
        JSON.stringify({
          packageId: manifest.value.id,
          manifestDigest,
          sourceDigest,
        }),
      ],
    );
    if (projected.rowCount !== 1)
      throw new Error(
        "subplatform organization scope projection returned no row",
      );
    await client.query(
      `INSERT INTO subplatform_registrations
        (id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
         pinned_revision, source_digest, manifest_digest, build_digest, manifest,
         requested_scopes, membership_policy, version, state, registered_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
               decode($9, 'hex'), decode($10, 'hex'), $11, $12::jsonb, $13, $14,
               $15::bigint, 'validated', $16)`,
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
        version,
        session.user.id,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (organizationCreated) {
      await authDatabase
        .query('DELETE FROM "organization" WHERE id = $1::uuid', [
          organization.id,
        ])
        .catch(() => undefined);
    }
    console.error("subplatform registration persistence failed", error);
    return NextResponse.json(
      { error: "子平台注册记录保存失败" },
      { status: 500 },
    );
  } finally {
    client?.release();
  }

  return NextResponse.json(
    {
      registrationId,
      organizationId: organization.id,
      slug: organization.slug,
      state: "validated",
      version,
      manifestDigest,
      sourceDigest,
      next: "isolated_builder_must_attach_build_digest_before_activation",
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
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
  const configuredTenantId =
    process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(configuredTenantId)) {
    return NextResponse.json(
      { error: "root tenant 尚未配置" },
      { status: 503 },
    );
  }
  let requestedParentId: string | null;
  try {
    requestedParentId = new URL(request.url).searchParams.get(
      "parentOrganizationId",
    );
  } catch {
    return NextResponse.json({ error: "请求 URL 无效" }, { status: 400 });
  }
  if (requestedParentId && !isUuid(requestedParentId)) {
    return NextResponse.json(
      { error: "parentOrganizationId must be a UUID" },
      { status: 400 },
    );
  }
  const configuredRootOrganizationId =
    process.env.MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID?.trim() ?? null;
  const rootOrganizationId =
    configuredRootOrganizationId && isUuid(configuredRootOrganizationId)
      ? configuredRootOrganizationId
      : ((
          await authDatabase.query<{ id: string }>(
            `SELECT id::text
           FROM "organization"
          WHERE "tenantId" = $1
            AND "parentOrganizationId" IS NULL
            AND "rootPlatform" = true
          LIMIT 1`,
            [configuredTenantId],
          )
        ).rows[0]?.id ?? null);
  if (requestedParentId && requestedParentId !== rootOrganizationId) {
    return NextResponse.json(
      { error: "商城只展示直接接入的店铺" },
      { status: 400 },
    );
  }
  const parentId = rootOrganizationId;
  const userRole = (session.user as { role?: string }).role;
  if (!(await canManageParent(session.user.id, userRole, parentId || null))) {
    return NextResponse.json({ error: "平台管理员权限不足" }, { status: 403 });
  }
  const rows = await authDatabase.query(
    `SELECT node.id,
            node.name,
            node.slug,
            node."parentOrganizationId" AS "parentOrganizationId",
            node."tenantId" AS "tenantId",
            node."domainId" AS "domainId",
            node."sourceRepository" AS "sourceRepository",
            node."createdAt" AS "createdAt",
            registration.id AS "registrationId",
            registration.state AS "registrationState",
            registration.source_kind AS "sourceKind",
            registration.source_locator AS "sourceLocator",
            registration.pinned_revision AS "pinnedRevision",
            registration.version::text AS "registrationVersion",
            encode(registration.build_digest, 'hex') AS "buildDigest",
            encode(registration.manifest_digest, 'hex') AS "manifestDigest",
            registration.build_attempts AS "buildAttempts",
            registration.build_error AS "buildError"
       FROM "organization" node
       LEFT JOIN LATERAL (
         SELECT r.id, r.state, r.source_kind, r.source_locator, r.pinned_revision, r.version, r.build_digest, r.manifest_digest,
                r.build_attempts, r.build_error
           FROM subplatform_registrations r
          WHERE r.slug = node.slug
            AND r.tenant_id::text = node."tenantId"
          ORDER BY r.version DESC
          LIMIT 1
       ) registration ON true
      WHERE node."tenantId" = $2
        AND node."rootPlatform" = false
        AND node."parentOrganizationId" = $1::uuid
      ORDER BY node."createdAt" ASC`,
    [parentId, configuredTenantId],
  );
  return NextResponse.json(
    { organizations: rows.rows },
    { headers: { "cache-control": "no-store" } },
  );
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
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SyntaxError("object required");
  return body as RegistrationRequest;
}

async function canManageParent(
  userId: string,
  role: string | null | undefined,
  parentId: string | null,
): Promise<boolean> {
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

async function readRootOrganizationId(
  tenantId: string,
): Promise<string | null> {
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
  if (!locator || locator.length > MAX_SOURCE_LOCATOR_LENGTH)
    return "sourceLocator 长度必须为 1..2048";
  const revision = input.pinnedRevision?.trim();
  if (!revision || !/^[0-9a-f]{7,128}$/i.test(revision))
    return "pinnedRevision 必须是不可变的 commit/digest";
  if (input.sourceKind === "git") {
    try {
      const url = new URL(locator);
      if (
        !(url.protocol === "https:" || url.protocol === "ssh:") ||
        url.username ||
        url.password ||
        !url.hostname
      ) {
        return "git sourceLocator 只能使用不带凭据的 HTTPS/SSH URL";
      }
    } catch {
      return "git sourceLocator 不是有效 URL";
    }
  } else if (!input.sourceDigest) {
    return "archive 注册必须提供上传对象的 SHA-256 sourceDigest";
  } else if (
    !locator.startsWith("upload://") &&
    !locator.startsWith("https://")
  ) {
    return "archive sourceLocator 必须是 upload:// 或 HTTPS 不可变对象地址";
  }
  if (!input.sourceDigest || !/^[0-9a-f]{64}$/i.test(input.sourceDigest))
    return "sourceDigest 必须是已验证来源的 SHA-256";
  return null;
}

function validateManifest(
  value: unknown,
  slug: string | undefined,
  packageId: string | undefined,
): { ok: true; value: Manifest } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "manifest 必须是 JSON 对象" };
  const manifest = value as Partial<Manifest>;
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES)
    return { ok: false, error: "manifest 过大" };
  const unknownKey = Object.keys(manifest).find(
    (key) => !manifestKeys.has(key),
  );
  if (unknownKey)
    return { ok: false, error: `manifest 包含未声明字段: ${unknownKey}` };
  if (
    manifest.apiVersion !== "matchplane.subplatform/v1" ||
    manifest.rootApiVersion !== "v1"
  )
    return { ok: false, error: "manifest API 版本不受支持" };
  if (
    !stringMatches(manifest.id, /^[a-z0-9][a-z0-9._-]{1,127}$/) ||
    manifest.id !== packageId
  )
    return { ok: false, error: "manifest.id 与 packageId 不一致" };
  if (
    !stringMatches(manifest.slug, /^[a-z0-9][a-z0-9-]{1,62}$/) ||
    manifest.slug === "root" ||
    manifest.slug !== slug
  )
    return { ok: false, error: "manifest.slug 与 slug 不一致或使用了保留值" };
  if (
    !stringMatches(manifest.displayName, /^.{1,200}$/u) ||
    !stringMatches(manifest.entry, /^(?!\/)(?!.*\.\.).+$/)
  )
    return { ok: false, error: "manifest displayName/entry 无效" };
  if (
    manifest.description !== undefined &&
    !stringMatches(manifest.description, /^.{0,2000}$/u)
  )
    return { ok: false, error: "manifest.description 无效" };
  if (
    manifest.marketplaceContract !== undefined &&
    manifest.marketplaceContract !== "generic-v1" &&
    manifest.marketplaceContract !== "legacy-v1"
  ) {
    return { ok: false, error: "manifest.marketplaceContract 无效" };
  }
  if (
    manifest.pricing !== undefined &&
    !validateManifestPricing(manifest.pricing)
  )
    return { ok: false, error: "manifest.pricing 无效" };
  if (manifest.email !== undefined && !validateManifestEmail(manifest.email))
    return { ok: false, error: "manifest.email 无效" };
  if (manifest.ui !== undefined && !validateManifestUi(manifest.ui))
    return { ok: false, error: "manifest.ui 无效" };
  if (
    !Array.isArray(manifest.routes) ||
    manifest.routes.length === 0 ||
    manifest.routes[0] !== `/${manifest.slug}` ||
    manifest.routes.some(
      (route) => !stringMatches(route, /^\/[a-z0-9][a-z0-9-]*(?:\/.*)?$/),
    )
  ) {
    return { ok: false, error: "manifest.routes 无效，第一条路由必须是 /slug" };
  }
  if (
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.some((item) => !stringMatches(item, /^[a-z0-9_:-]+$/))
  )
    return { ok: false, error: "manifest.capabilities 无效" };
  if (
    !Array.isArray(manifest.requiredScopes) ||
    manifest.requiredScopes.some((item) => !allowedScopes.has(item))
  )
    return { ok: false, error: "manifest.requiredScopes 无效" };
  if (
    !manifest.assets ||
    typeof manifest.assets !== "object" ||
    !stringMatches(manifest.assets.staticDirectory, /^(?!\/)(?!.*\.\.).+$/) ||
    !stringMatches(manifest.assets.buildCommand, /^.{1,500}$/u)
  )
    return { ok: false, error: "manifest.assets 无效" };
  if (
    manifest.assets.dependencyPolicy !== undefined &&
    manifest.assets.dependencyPolicy !== "locked" &&
    manifest.assets.dependencyPolicy !== "latest"
  )
    return { ok: false, error: "manifest.assets.dependencyPolicy 无效" };
  if (
    manifest.assets.dependencyPolicy === "latest" &&
    manifest.assets.buildCommand.trim() !== "bun run build"
  )
    return { ok: false, error: "latest 依赖策略目前只支持 bun run build" };
  if (manifest.agent && !validateAgentManifest(manifest.agent))
    return { ok: false, error: "manifest.agent 无效" };
  if (
    manifest.retrieval &&
    (manifest.retrieval.protocol !== "matchplane.retrieval/v1" ||
      manifest.retrieval.owner !== "subplatform")
  )
    return {
      ok: false,
      error: "manifest.retrieval 必须声明 subplatform-owned v1",
    };
  return { ok: true, value: manifest as Manifest };
}

function normalizeScopes(scopes: unknown): string[] | null {
  if (
    !Array.isArray(scopes) ||
    scopes.length > 32 ||
    scopes.some(
      (scope) => typeof scope !== "string" || !allowedScopes.has(scope),
    )
  )
    return null;
  return [
    ...new Set(
      scopes.filter((scope): scope is string => typeof scope === "string"),
    ),
  ];
}

function isSourceKind(
  value: RegistrationRequest["sourceKind"],
): value is "git" | "archive" {
  return value === "git" || value === "archive";
}

function stringMatches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function validateManifestEmail(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const email = value as { providerKey?: unknown; fromAddress?: unknown };
  if (
    email.providerKey !== undefined &&
    !stringMatches(email.providerKey, /^[a-z0-9][a-z0-9._-]{1,99}$/)
  )
    return false;
  if (
    email.fromAddress !== undefined &&
    !stringMatches(email.fromAddress, /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  )
    return false;
  return true;
}

function validateManifestPricing(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pricing = value as {
    mode?: unknown;
    currency?: unknown;
    currencyScale?: unknown;
    label?: unknown;
  };
  if (
    Object.keys(pricing).some(
      (key) =>
        !new Set(["mode", "currency", "currencyScale", "label"]).has(key),
    )
  )
    return false;
  if (!["fixed", "range", "negotiable", "none"].includes(String(pricing.mode)))
    return false;
  if (
    pricing.currency !== undefined &&
    !stringMatches(pricing.currency, /^[A-Z]{3}$/)
  )
    return false;
  if (
    pricing.currencyScale !== undefined &&
    (!Number.isInteger(pricing.currencyScale) ||
      Number(pricing.currencyScale) < 0 ||
      Number(pricing.currencyScale) > 18)
  )
    return false;
  if (
    pricing.label !== undefined &&
    !stringMatches(pricing.label, /^.{0,120}$/u)
  )
    return false;
  if (
    pricing.mode === "fixed" &&
    !stringMatches(pricing.currency, /^[A-Z]{3}$/)
  )
    return false;
  if (pricing.mode === "none" && pricing.currencyScale !== undefined)
    return false;
  return true;
}

function validateAgentManifest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as {
    protocol?: unknown;
    stages?: unknown;
    skills?: unknown;
    mcpTools?: unknown;
    mcpServerKey?: unknown;
  };
  if (
    Object.keys(agent).some(
      (key) =>
        !new Set([
          "protocol",
          "stages",
          "skills",
          "mcpTools",
          "mcpServerKey",
        ]).has(key),
    )
  )
    return false;
  if (agent.protocol !== "matchplane.agent/v1") return false;
  if (
    !Array.isArray(agent.stages) ||
    agent.stages.length > 8 ||
    agent.stages.some(
      (stage) => !stringMatches(stage, /^[a-z0-9][a-z0-9._:-]{1,127}$/),
    )
  )
    return false;
  if (
    !Array.isArray(agent.skills) ||
    agent.skills.length > 32 ||
    agent.skills.some(
      (skill) => !stringMatches(skill, /^[a-z0-9][a-z0-9._:-]{1,127}$/),
    )
  )
    return false;
  if (
    !Array.isArray(agent.mcpTools) ||
    agent.mcpTools.length > 64 ||
    agent.mcpTools.some(
      (tool) => !stringMatches(tool, /^[a-z0-9][a-z0-9._:-]{1,127}$/),
    )
  )
    return false;
  if (
    agent.mcpServerKey !== undefined &&
    !stringMatches(agent.mcpServerKey, /^[a-z0-9][a-z0-9._:-]{1,127}$/)
  )
    return false;
  return true;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
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
  pricing?: {
    mode: "fixed" | "range" | "negotiable" | "none";
    currency?: string;
    currencyScale?: number;
    label?: string;
  };
  email?: { providerKey?: string; fromAddress?: string };
  ui?: {
    chat?: Record<string, string>;
    copy?: Record<string, string>;
    filters?: Array<{
      key: string;
      label: string;
      source: "trust" | "price" | "attribute";
      attribute?: string;
      value?: string;
    }>;
    /** Public offer attributes only; private vehicle records cannot be declared here. */
    supplyFields?: Array<{
      key: string;
      label: string;
      type?: "text" | "textarea" | "number" | "url" | "date" | "select";
      required?: boolean;
      placeholder?: string;
      options?: string[];
      group?: string;
      help?: string;
      unit?: string;
      min?: number;
      max?: number;
      step?: number;
    }>;
  };
  rootApiVersion: "v1";
  entry: string;
  routes: string[];
  capabilities: string[];
  requiredScopes: string[];
  assets: {
    staticDirectory: string;
    buildCommand: string;
    dependencyPolicy?: "locked" | "latest";
  };
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
