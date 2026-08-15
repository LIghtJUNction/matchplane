import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT_REFERENCE_ID = "root-platform";
const OIDC_SCOPES = "openid profile email";

/**
 * Root-admin control plane for cross-origin MatchPlane children.
 *
 * Better Auth remains the OAuth/OIDC owner: validation, hashing, client CRUD and
 * secret generation all go through its provider API.  This route adds the
 * MatchPlane-specific binding to an active child registration and deliberately
 * never returns an existing secret.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireRootAdmin(request);
  if (guard.response) return guard.response;

  try {
    const result = await authDatabase.query<OAuthClientRow>(
      `SELECT "clientId", "name", "uri", "redirectUris", "scopes", "disabled",
              "requirePKCE", "createdAt", "updatedAt", "metadata"
         FROM "oauthClient"
        WHERE "referenceId" = $1
        ORDER BY "createdAt" DESC NULLS LAST, "clientId" ASC`,
      [ROOT_REFERENCE_ID],
    );
    return NextResponse.json(
      { clients: result.rows.map(toPublicClient) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("OIDC client listing failed", error);
    return NextResponse.json({ error: "OIDC 客户端存储尚未完成迁移" }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const guard = await requireRootAdmin(request);
  if (guard.response) return guard.response;

  const input = await parseJson(request);
  if (!input || typeof input !== "object") {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }

  const registrationId = stringValue(input.subplatformRegistrationId);
  if (!registrationId || !isUuid(registrationId)) {
    return NextResponse.json({ error: "subplatformRegistrationId 必须是 UUID" }, { status: 400 });
  }
  const registration = await findActiveRegistration(registrationId);
  if (!registration) {
    return NextResponse.json({ error: "只能为已激活的子平台登记 OIDC 客户端" }, { status: 400 });
  }

  const clientName = stringValue(input.clientName);
  if (!clientName || clientName.length > 120) {
    return NextResponse.json({ error: "clientName 必须为 1..120 个字符" }, { status: 400 });
  }
  const redirectUris = validateUriList(input.redirectUris, "redirectUris", 10);
  if (!redirectUris.ok) return NextResponse.json({ error: redirectUris.error }, { status: 400 });
  const clientUri = validateOptionalUri(input.clientUri, "clientUri");
  if (!clientUri.ok) return NextResponse.json({ error: clientUri.error }, { status: 400 });
  const postLogoutRedirectUris = input.postLogoutRedirectUris === undefined
    ? undefined
    : validateUriList(input.postLogoutRedirectUris, "postLogoutRedirectUris", 10);
  if (postLogoutRedirectUris && !postLogoutRedirectUris.ok) {
    return NextResponse.json({ error: postLogoutRedirectUris.error }, { status: 400 });
  }

  try {
    const created = await auth.api.adminCreateOAuthClient({
      headers: request.headers,
      body: {
        redirect_uris: redirectUris.value,
        scope: OIDC_SCOPES,
        client_name: clientName,
        client_uri: clientUri.value,
        post_logout_redirect_uris: postLogoutRedirectUris?.value,
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        type: "web",
        require_pkce: true,
        skip_consent: false,
        metadata: {
          matchplane_subplatform_registration_id: registration.id,
          matchplane_subplatform_slug: registration.slug,
          matchplane_package_id: registration.packageId,
        },
      },
    });
    return NextResponse.json(
      {
        ...created,
        matchplane: {
          subplatformRegistrationId: registration.id,
          subplatformSlug: registration.slug,
          packageId: registration.packageId,
        },
        secretHandling: "client_secret 只在本次响应返回；必须保存于子平台服务端密钥存储。",
      },
      {
        status: 201,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      },
    );
  } catch (error) {
    console.error("OIDC client creation failed", error);
    return NextResponse.json({ error: "OIDC 客户端创建失败，请确认 Better Auth 迁移已完成" }, { status: 409 });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const guard = await requireRootAdmin(request);
  if (guard.response) return guard.response;
  const input = await parseJson(request);
  if (!input || typeof input !== "object") {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const clientId = stringValue(input.clientId);
  const action = stringValue(input.action) ?? "update";
  if (!clientId || clientId.length > 256) {
    return NextResponse.json({ error: "clientId 无效" }, { status: 400 });
  }

  try {
    if (action === "rotate-secret") {
      const rotated = await auth.api.rotateClientSecret({
        headers: request.headers,
        body: { client_id: clientId },
      });
      return NextResponse.json(
        { ...rotated, secretHandling: "新 client_secret 只在本次响应返回；旧密钥立即失效。" },
        { headers: { "cache-control": "no-store", pragma: "no-cache" } },
      );
    }

    if (action === "enable" || action === "disable") {
      const result = await authDatabase.query<{ clientId: string; disabled: boolean }>(
        `UPDATE "oauthClient"
            SET "disabled" = $2, "updatedAt" = clock_timestamp()
          WHERE "clientId" = $1 AND "referenceId" = $3
          RETURNING "clientId", "disabled"`,
        [clientId, action === "disable", ROOT_REFERENCE_ID],
      );
      if (result.rowCount !== 1) return NextResponse.json({ error: "OIDC 客户端不存在" }, { status: 404 });
      if (action === "disable") {
        // JWT access tokens are rejected by the provider's disabled-client check;
        // opaque refresh tokens also need explicit revocation to stop renewal.
        await authDatabase.query(
          `UPDATE "oauthRefreshToken"
              SET "revoked" = COALESCE("revoked", clock_timestamp())
            WHERE "clientId" = $1`,
          [clientId],
        );
      }
      return NextResponse.json({ clientId, disabled: action === "disable" }, { headers: { "cache-control": "no-store" } });
    }

    if (action !== "update") {
      return NextResponse.json({ error: "action 必须是 update、rotate-secret、enable 或 disable" }, { status: 400 });
    }
    const update: {
      redirect_uris?: string[];
      client_name?: string;
      client_uri?: string;
    } = {};
    if (input.redirectUris !== undefined) {
      const redirectUris = validateUriList(input.redirectUris, "redirectUris", 10);
      if (!redirectUris.ok) return NextResponse.json({ error: redirectUris.error }, { status: 400 });
      update.redirect_uris = redirectUris.value;
    }
    if (input.clientName !== undefined) {
      const clientName = stringValue(input.clientName);
      if (!clientName || clientName.length > 120) {
        return NextResponse.json({ error: "clientName 必须为 1..120 个字符" }, { status: 400 });
      }
      update.client_name = clientName;
    }
    if (input.clientUri !== undefined) {
      const clientUri = validateOptionalUri(input.clientUri, "clientUri");
      if (!clientUri.ok) return NextResponse.json({ error: clientUri.error }, { status: 400 });
      update.client_uri = clientUri.value;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
    }
    const updated = await auth.api.adminUpdateOAuthClient({
      headers: request.headers,
      body: { client_id: clientId, update },
    });
    return NextResponse.json(updated, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("OIDC client update failed", error);
    return NextResponse.json({ error: "OIDC 客户端更新失败" }, { status: 409 });
  }
}

/** Disable rather than delete: revocation must remain auditable and recoverable. */
export async function DELETE(request: Request): Promise<Response> {
  const guard = await requireRootAdmin(request);
  if (guard.response) return guard.response;
  const clientId = new URL(request.url).searchParams.get("client_id")?.trim();
  if (!clientId || clientId.length > 256) return NextResponse.json({ error: "client_id 无效" }, { status: 400 });
  try {
    const result = await authDatabase.query(
      `UPDATE "oauthClient"
          SET "disabled" = true, "updatedAt" = clock_timestamp()
        WHERE "clientId" = $1 AND "referenceId" = $2`,
      [clientId, ROOT_REFERENCE_ID],
    );
    if (result.rowCount !== 1) return NextResponse.json({ error: "OIDC 客户端不存在" }, { status: 404 });
    await authDatabase.query(
      `UPDATE "oauthRefreshToken"
          SET "revoked" = COALESCE("revoked", clock_timestamp())
        WHERE "clientId" = $1`,
      [clientId],
    );
    return NextResponse.json({ clientId, disabled: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("OIDC client revocation failed", error);
    return NextResponse.json({ error: "OIDC 客户端撤销失败" }, { status: 409 });
  }
}

async function requireRootAdmin(request: Request): Promise<{
  response?: Response;
  user?: { id: string; role?: unknown };
}> {
  if (process.env.MATCHPLANE_OIDC_ENABLED === "false") {
    return { response: NextResponse.json({ error: "根平台 OIDC 未启用" }, { status: 404 }) };
  }
  if (!hasTrustedBrowserOrigin(request)) {
    return { response: NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 }) };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: NextResponse.json({ error: "Better Auth session is required" }, { status: 401 }) };
  const role = (session.user as { role?: unknown }).role;
  if (role !== "rootSuperAdmin" && role !== "rootAdmin") {
    return { response: NextResponse.json({ error: "只有根平台管理员可以管理跨域客户端" }, { status: 403 }) };
  }
  return { user: { id: session.user.id, role } };
}

async function findActiveRegistration(id: string): Promise<RegistrationRow | null> {
  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId)) return null;
  const result = await authDatabase.query<RegistrationRow>(
    `SELECT id, slug, package_id AS "packageId"
       FROM subplatform_registrations
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND state = 'active'
      LIMIT 1`,
    [id, rootTenantId],
  );
  return result.rows[0] ?? null;
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateUriList(value: unknown, field: string, max: number):
  | { ok: true; value: string[] }
  | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    return { ok: false, error: `${field} 必须包含 1..${max} 个精确回调地址` };
  }
  const values: string[] = [];
  for (const candidate of value) {
    const checked = validateUri(candidate, field);
    if (!checked.ok) return checked;
    values.push(checked.value);
  }
  if (new Set(values).size !== values.length) return { ok: false, error: `${field} 不得包含重复地址` };
  return { ok: true, value: values };
}

function validateOptionalUri(value: unknown, field: string):
  | { ok: true; value: string | undefined }
  | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  const checked = validateUri(value, field);
  return checked.ok ? checked : { ok: false, error: checked.error };
}

function validateUri(value: unknown, field: string):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    return { ok: false, error: `${field} 包含无效地址` };
  }
  try {
    const uri = new URL(value);
    const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname);
    if (uri.protocol !== "https:" && !(uri.protocol === "http:" && localhost)) {
      return { ok: false, error: `${field} 必须使用 HTTPS（本地开发仅允许 localhost）` };
    }
    if (uri.username || uri.password || uri.hash || value.includes("*")) {
      return { ok: false, error: `${field} 不得包含凭据、片段或通配符` };
    }
    return { ok: true, value: uri.toString() };
  } catch {
    return { ok: false, error: `${field} 包含无效地址` };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

interface RegistrationRow {
  id: string;
  slug: string;
  packageId: string;
}

interface OAuthClientRow {
  clientId: string;
  name: string | null;
  uri: string | null;
  redirectUris: unknown;
  scopes: unknown;
  disabled: boolean | null;
  requirePKCE: boolean | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  metadata: unknown;
}

function toPublicClient(row: OAuthClientRow) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    clientId: row.clientId,
    clientName: row.name,
    clientUri: row.uri,
    redirectUris: asStringArray(row.redirectUris),
    scopes: asStringArray(row.scopes),
    disabled: row.disabled === true,
    requirePkce: row.requirePKCE !== false,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    matchplane: metadata,
  };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}
