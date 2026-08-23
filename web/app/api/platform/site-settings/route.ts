import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  readJsonResponseBody,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { requestSearchParams } from "../../../../src/lib/request-url";
import {
  isMountedPlatformPath,
  readActivePlatformScope,
} from "../../../../src/platform-mount";
import { isActivePlatformPathVisible } from "../../../../src/platform-visibility";
import { isUuid } from "../../../../src/lib/uuid";
import { jsonError } from "../../../../src/lib/json-error";
import { configuredTenantId } from "../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Platform-owned public/legal metadata. Filing data is never inferred in the browser and is
 * never bundled into a vertical package. The same endpoint serves the root node and mounted
 * child nodes; only the organization manager may write it.
 */
export async function GET(request: Request): Promise<Response> {
  const query = requestSearchParams(request);
  const organizationId = readUuid(query.get("organizationId"));
  const platformPath = normalizePlatformPath(query.get("platformPath") ?? "/");

  if (organizationId) {
    const access = await requireOrganizationManager(request, organizationId);
    if (access.response) return access.response;
    return readSettings(access.organization.id, access.organization.tenantId);
  }

  if (!platformPath || !(await isMountedPlatformPath(platformPath))) {
    return jsonError("平台路径尚未激活", 404);
  }
  if (!(await isActivePlatformPathVisible(platformPath))) {
    return jsonError("平台备案信息不可公开读取", 404);
  }
  const scope = await resolvePublicScope(platformPath);
  // The root page is useful before first-run setup is complete.  Treat its optional
  // filing metadata as an empty public resource instead of turning an uninitialized
  // deployment into a noisy 404 in the browser console.  Mounted child paths still
  // fail closed when their registration tree cannot be resolved.
  if (!scope) {
    if (platformPath === "/") {
      return NextResponse.json(
        { settings: emptySettings(null, null) },
        noStore(),
      );
    }
    return jsonError("平台范围尚未初始化", 404);
  }
  return readSettings(scope.organizationId, scope.tenantId);
}

export async function PATCH(request: Request): Promise<Response> {
  const input = await parseJson(request);
  const organizationId = readUuid(input.organizationId);
  if (!organizationId) return jsonError("organizationId 必须是 UUID", 400);
  const access = await requireOrganizationManager(request, organizationId);
  if (access.response) return access.response;

  const values = normalizeSettings(input);
  if (!values.ok) return jsonError(values.error, 400);
  const expectedVersion = readVersion(input.expectedVersion);

  try {
    const existing = await authDatabase.query<SiteSettingsRow>(
      `SELECT organization_id::text, tenant_id::text, icp_number, icp_subject, icp_record_url,
              public_security_number, public_security_url, lookup_source, lookup_checked_at,
              version::text, updated_at
         FROM platform_site_settings
        WHERE organization_id = $1::uuid
        LIMIT 1`,
      [organizationId],
    );
    const current = existing.rows[0];
    if (!current) {
      if (expectedVersion !== undefined)
        return jsonError("备案设置尚未创建，不能携带 expectedVersion", 409);
      const inserted = await authDatabase.query<SiteSettingsRow>(
        `INSERT INTO platform_site_settings
          (organization_id, tenant_id, icp_number, icp_subject, icp_record_url,
           public_security_number, public_security_url, lookup_source, lookup_checked_at, updated_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::uuid)
         RETURNING organization_id::text, tenant_id::text, icp_number, icp_subject, icp_record_url,
                   public_security_number, public_security_url, lookup_source, lookup_checked_at,
                   version::text, updated_at`,
        [
          access.organization.id,
          access.organization.tenantId,
          values.icpNumber,
          values.icpSubject,
          values.icpRecordUrl,
          values.publicSecurityNumber,
          values.publicSecurityUrl,
          null,
          null,
          access.userId,
        ],
      );
      return NextResponse.json(
        { settings: toPublicSettings(inserted.rows[0]) },
        noStore(),
      );
    }

    const updated = await authDatabase.query<SiteSettingsRow>(
      `UPDATE platform_site_settings
          SET icp_number = $3,
              icp_subject = $4,
              icp_record_url = $5,
              public_security_number = $6,
              public_security_url = $7,
              lookup_source = NULL,
              lookup_checked_at = NULL,
              updated_by = $8::uuid,
              version = version + 1
        WHERE organization_id = $1::uuid
          AND tenant_id = $2::uuid
          AND ($9::bigint IS NULL OR version = $9::bigint)
        RETURNING organization_id::text, tenant_id::text, icp_number, icp_subject, icp_record_url,
                  public_security_number, public_security_url, lookup_source, lookup_checked_at,
                  version::text, updated_at`,
      [
        access.organization.id,
        access.organization.tenantId,
        values.icpNumber,
        values.icpSubject,
        values.icpRecordUrl,
        values.publicSecurityNumber,
        values.publicSecurityUrl,
        access.userId,
        expectedVersion ?? null,
      ],
    );
    if (updated.rowCount !== 1)
      return jsonError("备案设置已被其他管理员更新，请刷新后再保存", 409);
    return NextResponse.json(
      { settings: toPublicSettings(updated.rows[0]) },
      noStore(),
    );
  } catch (error) {
    if (isMissingSettingsTable(error))
      return jsonError("数据库尚未执行平台备案设置迁移", 503);
    console.error("platform site settings update failed", error);
    return jsonError("备案设置保存失败", 500);
  }
}

/**
 * Optional server-side lookup bridge. Mainland filing registries do not expose a stable
 * browser-safe public API, so MatchPlane only calls an operator-configured provider. The
 * provider returns the same bounded field names as this resource; results are shown for review
 * and are not persisted until the administrator presses save.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await parseJson(request);
  if (input.action !== "lookup") return jsonError("只支持 action=lookup", 400);
  const organizationId = readUuid(input.organizationId);
  if (!organizationId) return jsonError("organizationId 必须是 UUID", 400);
  const access = await requireOrganizationManager(request, organizationId);
  if (access.response) return access.response;

  const lookupUrl = process.env.MATCHPLANE_ICP_LOOKUP_URL?.trim();
  if (!lookupUrl || !isHttpsOrLoopbackUrl(lookupUrl)) {
    return jsonError(
      "尚未配置 MATCHPLANE_ICP_LOOKUP_URL；请先手动填写备案信息或接入查询服务",
      503,
    );
  }
  const hostname =
    normalizeHostname(input.hostname) ??
    normalizeHostname(request.headers.get("host"));
  if (!hostname) return jsonError("当前请求没有可查询的域名", 400);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(lookupUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(process.env.MATCHPLANE_ICP_LOOKUP_TOKEN?.trim()
          ? {
              authorization: `Bearer ${process.env.MATCHPLANE_ICP_LOOKUP_TOKEN.trim()}`,
            }
          : {}),
      },
      body: JSON.stringify({
        hostname,
        platformPath: input.platformPath ?? "/",
      }),
      signal: controller.signal,
    });
    if (!response.ok) return jsonError("备案查询服务暂时不可用", 502);
    const body = await readJsonResponseBody<unknown>(
      response,
      256 * 1024,
    ).catch(() => null);
    const values = normalizeLookupResponse(body);
    if (!values.ok)
      return jsonError("备案查询服务没有返回可验证的备案字段", 502);
    return NextResponse.json(
      {
        settings: {
          organization_id: access.organization.id,
          tenant_id: access.organization.tenantId,
          ...values.settings,
          lookup_source: lookupUrl,
          lookup_checked_at: new Date().toISOString(),
        },
      },
      noStore(),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      return jsonError("备案查询超时，请稍后重试", 504);
    console.error("platform site settings lookup failed", error);
    return jsonError("备案查询失败，请稍后重试", 502);
  } finally {
    clearTimeout(timeout);
  }
}

interface OrganizationScope {
  id: string;
  tenantId: string;
  parentOrganizationId: string | null;
}

interface ManagerAccess {
  organization: OrganizationScope;
  userId: string;
  response?: undefined;
}

interface SiteSettingsRow {
  organization_id: string;
  tenant_id: string;
  icp_number: string | null;
  icp_subject: string | null;
  icp_record_url: string | null;
  public_security_number: string | null;
  public_security_url: string | null;
  lookup_source: string | null;
  lookup_checked_at: string | Date | null;
  version: string | number;
  updated_at: string | Date;
}

async function readSettings(
  organizationId: string,
  tenantId: string,
): Promise<Response> {
  try {
    const result = await authDatabase.query<SiteSettingsRow>(
      `SELECT organization_id::text, tenant_id::text, icp_number, icp_subject, icp_record_url,
              public_security_number, public_security_url, lookup_source, lookup_checked_at,
              version::text, updated_at
         FROM platform_site_settings
        WHERE organization_id = $1::uuid AND tenant_id = $2::uuid
        LIMIT 1`,
      [organizationId, tenantId],
    );
    return NextResponse.json(
      {
        settings: result.rows[0]
          ? toPublicSettings(result.rows[0])
          : emptySettings(organizationId, tenantId),
      },
      noStore(),
    );
  } catch (error) {
    if (isMissingSettingsTable(error))
      return jsonError("数据库尚未执行平台备案设置迁移", 503);
    console.error("platform site settings read failed", error);
    return jsonError("备案设置读取失败", 503);
  }
}

async function resolvePublicScope(
  platformPath: string,
): Promise<{ organizationId: string; tenantId: string } | null> {
  const tenantId = configuredTenantId();
  if (!tenantId) return null;
  if (platformPath !== "/") {
    const scope = await readActivePlatformScope(platformPath);
    return scope
      ? { organizationId: scope.organizationId, tenantId: scope.tenantId }
      : null;
  }
  const result = await authDatabase.query<{ id: string; tenant_id: string }>(
    `SELECT id::text, "tenantId"::text AS tenant_id
       FROM "organization"
      WHERE "tenantId" = $1
        AND "parentOrganizationId" IS NULL
        AND "rootPlatform" = true
      LIMIT 1`,
    [tenantId],
  );
  const row = result.rows[0];
  return row && isUuid(row.id) && isUuid(row.tenant_id)
    ? { organizationId: row.id, tenantId: row.tenant_id }
    : null;
}

async function requireOrganizationManager(
  request: Request,
  organizationId: string,
): Promise<ManagerAccess | { response: Response }> {
  if (!hasTrustedBrowserOrigin(request))
    return { response: jsonError("请求来源未被平台信任", 403) };
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return { response: jsonError("Better Auth session is required", 401) };
  const organization = await findOrganization(organizationId);
  if (!organization)
    return {
      response: jsonError("平台组织不存在或不属于当前 root tenant", 404),
    };

  const role = (session.user as { role?: unknown }).role;
  if (role === "rootSuperAdmin" || role === "rootAdmin") {
    return { organization, userId: session.user.id };
  }
  try {
    const full = await auth.api.getFullOrganization({
      query: { organizationId, membersLimit: 1000 },
      headers: request.headers,
    });
    const member = full?.members?.find(
      (candidate) => candidate.userId === session.user.id,
    );
    const canManage = member?.role
      .split(",")
      .some(
        (value) =>
          value === "owner" ||
          value === "admin" ||
          value === "subplatform_admin",
      );
    return canManage
      ? { organization, userId: session.user.id }
      : { response: jsonError("当前账号没有该平台的设置权限", 403) };
  } catch {
    return {
      response: jsonError("当前账号不是该平台的 Better Auth 成员", 403),
    };
  }
}

async function findOrganization(
  organizationId: string,
): Promise<OrganizationScope | null> {
  const tenantId = configuredTenantId();
  if (!tenantId) return null;
  const result = await authDatabase.query<OrganizationScope>(
    `SELECT id::text AS id, "tenantId"::text AS "tenantId",
            "parentOrganizationId"::text AS "parentOrganizationId"
       FROM "organization"
      WHERE id = $1::uuid AND "tenantId" = $2
      LIMIT 1`,
    [organizationId, tenantId],
  );
  const row = result.rows[0];
  return row && isUuid(row.id) && isUuid(row.tenantId) ? row : null;
}

function normalizeSettings(
  input: Record<string, unknown>,
):
  | {
      ok: true;
      icpNumber: string | null;
      icpSubject: string | null;
      icpRecordUrl: string | null;
      publicSecurityNumber: string | null;
      publicSecurityUrl: string | null;
    }
  | { ok: false; error: string } {
  const icpNumber = optionalText(input.icpNumber, 128);
  const icpSubject = optionalText(input.icpSubject, 200);
  const icpRecordUrl = optionalUrl(input.icpRecordUrl);
  const publicSecurityNumber = optionalText(input.publicSecurityNumber, 128);
  const publicSecurityUrl = optionalUrl(input.publicSecurityUrl);
  if (
    icpNumber === undefined ||
    icpSubject === undefined ||
    publicSecurityNumber === undefined
  )
    return { ok: false, error: "备案字段必须是字符串或 null" };
  if (icpRecordUrl === undefined || publicSecurityUrl === undefined)
    return { ok: false, error: "备案链接必须是 HTTPS 地址或 null" };
  if (
    !icpNumber &&
    !icpSubject &&
    !icpRecordUrl &&
    !publicSecurityNumber &&
    !publicSecurityUrl
  ) {
    return { ok: false, error: "至少填写一项备案信息" };
  }
  return {
    ok: true,
    icpNumber,
    icpSubject,
    icpRecordUrl,
    publicSecurityNumber,
    publicSecurityUrl,
  };
}

function normalizeLookupResponse(
  input: unknown,
): { ok: true; settings: Record<string, string | null> } | { ok: false } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false };
  const body = input as Record<string, unknown>;
  const candidate =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;
  const normalized = normalizeSettings({
    icpNumber:
      candidate.icpNumber ?? candidate.icp_number ?? candidate.recordNumber,
    icpSubject:
      candidate.icpSubject ?? candidate.icp_subject ?? candidate.subject,
    icpRecordUrl: candidate.icpRecordUrl ?? candidate.icp_record_url,
    publicSecurityNumber:
      candidate.publicSecurityNumber ??
      candidate.public_security_number ??
      candidate.psbNumber,
    publicSecurityUrl:
      candidate.publicSecurityUrl ?? candidate.public_security_url,
  });
  return normalized.ok
    ? {
        ok: true,
        settings: {
          icp_number: normalized.icpNumber,
          icp_subject: normalized.icpSubject,
          icp_record_url: normalized.icpRecordUrl,
          public_security_number: normalized.publicSecurityNumber,
          public_security_url: normalized.publicSecurityUrl,
        },
      }
    : { ok: false };
}

function toPublicSettings(row: SiteSettingsRow) {
  return {
    organization_id: row.organization_id,
    tenant_id: row.tenant_id,
    icp_number: row.icp_number,
    icp_subject: row.icp_subject,
    icp_record_url: row.icp_record_url,
    public_security_number: row.public_security_number,
    public_security_url: row.public_security_url,
    lookup_source: row.lookup_source,
    lookup_checked_at: row.lookup_checked_at
      ? new Date(row.lookup_checked_at).toISOString()
      : null,
    version: Number(row.version) || 1,
    updated_at: new Date(row.updated_at).toISOString(),
    configured: Boolean(
      row.icp_number ||
        row.icp_subject ||
        row.icp_record_url ||
        row.public_security_number ||
        row.public_security_url,
    ),
  };
}

function emptySettings(organizationId: string | null, tenantId: string | null) {
  return {
    organization_id: organizationId,
    tenant_id: tenantId,
    icp_number: null,
    icp_subject: null,
    icp_record_url: null,
    public_security_number: null,
    public_security_url: null,
    lookup_source: null,
    lookup_checked_at: null,
    version: 1,
    updated_at: null,
    configured: false,
  };
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function optionalUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length > 2_048) return undefined;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/:\d+$/, "");
  return /^[a-z0-9](?:[a-z0-9.-]{0,252}[a-z0-9])?$/.test(normalized) &&
    normalized.includes(".")
    ? normalized
    : null;
}

function normalizePlatformPath(value: string): string | null {
  const normalized = value.trim() || "/";
  return normalized === "/" ||
    /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(normalized)
    ? normalized
    : null;
}

function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

function readVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const version =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

function readUuid(value: unknown): string | null {
  return typeof value === "string" && isUuid(value.trim())
    ? value.trim()
    : null;
}


async function parseJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isMissingSettingsTable(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "42P01",
  );
}

function noStore(): { headers: { "cache-control": string } } {
  return { headers: { "cache-control": "no-store" } };
}

