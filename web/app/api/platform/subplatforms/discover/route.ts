import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { isUuid } from "../../../../../src/lib/uuid";
import { jsonError } from "../../../../../src/lib/json-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOCATOR_LENGTH = 2_048;
const ALLOWED_SCOPES = new Set([
  "marketplace:read",
  "marketplace:write",
  "retrieval:query",
  "retrieval:write",
  "platform:read",
]);

/** Queue a source-only package for the isolated builder to inspect. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("Better Auth session is required", 401);
  let input: IntakeRequest;
  try {
    input = await parseBody(request);
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "源码发现请求体过大"
        : "请求 JSON 无效",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(tenantId)) return jsonError("root tenant 尚未配置", 503);
  const domainId = isUuid(input.domainId) ? input.domainId : null;
  if (!domainId) return jsonError("domainId 必须是 UUID", 400);
  const parentOrganizationId =
    input.parentOrganizationId === undefined ||
    input.parentOrganizationId === null
      ? null
      : isUuid(input.parentOrganizationId)
        ? input.parentOrganizationId
        : null;
  if (
    input.parentOrganizationId !== undefined &&
    input.parentOrganizationId !== null &&
    !parentOrganizationId
  ) {
    return jsonError("parentOrganizationId 必须是 UUID", 400);
  }
  const sourceKind =
    input.sourceKind === "git" || input.sourceKind === "archive"
      ? input.sourceKind
      : null;
  if (!sourceKind) return jsonError("sourceKind 必须是 git 或 archive", 400);
  const sourceLocator =
    typeof input.sourceLocator === "string" ? input.sourceLocator.trim() : "";
  const sourceError = validateSource(
    sourceKind,
    sourceLocator,
    input.sourceDigest,
  );
  if (sourceError) return jsonError(sourceError, 400);
  const membershipPolicy =
    input.membershipPolicy === "invite" ? "invite" : "public";
  const scopes = normalizeScopes(input.requestedScopes);
  if (!scopes) return jsonError("requestedScopes 包含未允许的权限", 400);

  const parentId = await readRootOrganizationId(tenantId);
  if (!parentId) return jsonError("商城初始化完成后即可接入店铺", 409);
  if (parentOrganizationId && parentOrganizationId !== parentId) {
    return jsonError("店铺只能直接接入商城，不能嵌套在其他店铺中", 400);
  }
  const role = (session.user as { role?: string }).role;
  if (!(await canManageParent(session.user.id, role, parentId)))
    return jsonError("当前账号没有导入该平台节点的权限", 403);
  const domain = await authDatabase.query(
    `SELECT 1 FROM domains WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active' LIMIT 1`,
    [tenantId, domainId],
  );
  if (domain.rowCount !== 1)
    return jsonError("domainId 不属于当前 root tenant 的 active domain", 400);

  const intakeId = randomUUID();
  const sourceDigest =
    typeof input.sourceDigest === "string" &&
    /^[0-9a-f]{64}$/i.test(input.sourceDigest)
      ? input.sourceDigest.toLowerCase()
      : null;
  await authDatabase.query(
    `INSERT INTO subplatform_source_intakes
      (id, tenant_id, domain_id, parent_organization_id, source_kind, source_locator,
       source_digest, requested_scopes, membership_policy, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
       CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7, 'hex') END, $8, $9, $10)`,
    [
      intakeId,
      tenantId,
      domainId,
      parentId,
      sourceKind,
      sourceLocator,
      sourceDigest,
      scopes,
      membershipPolicy,
      session.user.id,
    ],
  );
  return NextResponse.json(
    { intakeId, state: "queued", next: "isolated_builder_discovers_manifest" },
    {
      status: 202,
      headers: { "cache-control": "no-store" },
    },
  );
}

/** Read bounded discovery state for the authenticated operator who queued it. */
export async function GET(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("Better Auth session is required", 401);
  let id: string;
  try {
    id = new URL(request.url).searchParams.get("intakeId")?.trim() ?? "";
  } catch {
    return jsonError("请求 URL 无效", 400);
  }
  if (!isUuid(id)) return jsonError("intakeId 必须是 UUID", 400);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(tenantId)) return jsonError("root tenant 尚未配置", 503);
  const result = await authDatabase.query(
    `SELECT id::text AS "intakeId", state, source_kind AS "sourceKind", source_locator AS "sourceLocator",
            encode(source_digest, 'hex') AS "sourceDigest", pinned_revision AS "pinnedRevision",
            manifest, encode(manifest_digest, 'hex') AS "manifestDigest", requested_scopes AS "requestedScopes",
            membership_policy AS "membershipPolicy", error, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM subplatform_source_intakes
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND created_by = $3
      LIMIT 1`,
    [id, tenantId, session.user.id],
  );
  if (!result.rows[0]) return jsonError("源码导入任务不存在", 404);
  const row = result.rows[0] as Record<string, unknown>;
  const manifest = isRecord(row.manifest) ? row.manifest : null;
  return NextResponse.json(
    {
      ...row,
      packageId:
        manifest && typeof manifest.id === "string" ? manifest.id : null,
      slug:
        manifest && typeof manifest.slug === "string" ? manifest.slug : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface IntakeRequest {
  domainId?: unknown;
  parentOrganizationId?: unknown;
  sourceKind?: unknown;
  sourceLocator?: unknown;
  sourceDigest?: unknown;
  requestedScopes?: unknown;
  membershipPolicy?: unknown;
}

async function parseBody(request: Request): Promise<IntakeRequest> {
  try {
    const value = await readJsonBody<unknown>(request, 128 * 1024);
    return isRecord(value) ? (value as IntakeRequest) : {};
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return {};
  }
}

function validateSource(
  kind: "git" | "archive",
  locator: string,
  digest: unknown,
): string | null {
  if (!locator || locator.length > MAX_LOCATOR_LENGTH)
    return "sourceLocator 长度必须为 1..2048";
  if (kind === "git") {
    try {
      const url = new URL(locator);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname
      )
        return "Git 只接受不带凭据的 HTTPS 地址";
    } catch {
      return "Git sourceLocator 不是有效 HTTPS URL";
    }
    return null;
  }
  if (
    !/^upload:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      locator,
    )
  ) {
    return "压缩包必须先通过上传接口保存为 upload:// locator";
  }
  if (
    digest !== undefined &&
    (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest))
  )
    return "sourceDigest 必须是 SHA-256";
  return null;
}

function normalizeScopes(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  if (
    value.some((item) => typeof item !== "string" || !ALLOWED_SCOPES.has(item))
  )
    return null;
  return [...new Set(value as string[])];
}

async function canManageParent(
  userId: string,
  role: string | undefined,
  parentId: string,
): Promise<boolean> {
  if (role === "rootSuperAdmin" || role === "rootAdmin") return true;
  const result = await authDatabase.query(
    `SELECT 1 FROM member WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid
       AND role = ANY($3::text[]) LIMIT 1`,
    [parentId, userId, ["owner", "admin", "subplatform_admin"]],
  );
  return result.rowCount === 1;
}

async function readRootOrganizationId(
  tenantId: string,
): Promise<string | null> {
  const result = await authDatabase.query<{ id: string }>(
    `SELECT id::text FROM "organization" WHERE "tenantId" = $1 AND "parentOrganizationId" IS NULL
       AND "rootPlatform" = true LIMIT 1`,
    [tenantId],
  );
  return result.rows[0]?.id ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

