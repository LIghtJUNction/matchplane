import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import {
  digestAcquisitionToken,
  generateAcquisitionToken,
} from "../../../../../src/lib/acquisition-links";
import { auth, authDatabase } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  configuredTenantId,
  isUuid,
  readStoreAccess,
  roleOf,
  type StoreAccessRow,
} from "../../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REF_LENGTH = 128;
const CHANNEL_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

type ConfiguredLinkStatus = "active" | "disabled";
type EffectiveLinkStatus = ConfiguredLinkStatus | "expired" | "unavailable";
type LinkUnavailableReason =
  | "disabled"
  | "expired"
  | "destination_unavailable"
  | null;

interface LinkRow {
  id: string;
  offerId: string;
  channelKey: string;
  sourceRef: string | null;
  campaignRef: string | null;
  configuredStatus: ConfiguredLinkStatus;
  expiresAt: string | null;
  expired: boolean;
  destinationAvailable?: boolean;
  version: string | number;
  createdAt: string;
  updatedAt: string;
}

interface ManagerContext {
  session: { user: { id: string; [key: string]: unknown } };
  store: StoreAccessRow;
  tenantId: string;
}

type ManagerGuard =
  | { ok: true; value: ManagerContext }
  | { ok: false; response: Response };

export async function GET(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await context.params;
  const guard = await requireStoreManager(request, storeId);
  if (!guard.ok) return guard.response;

  try {
    const result = await authDatabase.query<LinkRow>(
      `SELECT link.id::text,
              link.offer_id::text AS "offerId",
              link.channel_key AS "channelKey",
              link.source_ref AS "sourceRef",
              link.campaign_ref AS "campaignRef",
              link.status AS "configuredStatus",
              link.expires_at::text AS "expiresAt",
              (link.expires_at IS NOT NULL
                AND link.expires_at <= statement_timestamp()) AS expired,
              (tenant.status = 'active'
                AND offer.status = 'active'
                AND (offer.expires_at IS NULL
                  OR offer.expires_at > statement_timestamp())
                AND canonical_store.status = 'active'
                AND canonical_store.visibility = 'public'
                AND scoped_domain.status = 'active') AS "destinationAvailable",
              link.version::text,
              link.created_at::text AS "createdAt",
              link.updated_at::text AS "updatedAt"
         FROM marketplace_acquisition_links link
         JOIN tenants tenant
           ON tenant.id = link.tenant_id
         JOIN marketplace_offers offer
           ON offer.tenant_id = link.tenant_id
          AND offer.domain_id = link.domain_id
          AND offer.store_id = link.store_id
          AND offer.id = link.offer_id
         JOIN stores canonical_store
           ON canonical_store.tenant_id = link.tenant_id
          AND canonical_store.domain_id = link.domain_id
          AND canonical_store.id = link.store_id
         JOIN domains scoped_domain
           ON scoped_domain.tenant_id = link.tenant_id
          AND scoped_domain.id = link.domain_id
        WHERE link.tenant_id = $1::uuid
          AND link.store_id = $2::uuid
        ORDER BY link.created_at DESC, link.id DESC
        LIMIT 100`,
      [guard.value.tenantId, storeId],
    );
    return NextResponse.json(
      { links: result.rows.map((row) => linkMetadata(row)) },
      { headers: privateHeaders() },
    );
  } catch {
    return error("渠道链接读取失败，请稍后重试", 500);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return error("请求来源未被商城信任", 403);
  }
  const { storeId } = await context.params;
  const guard = await requireStoreManager(request, storeId);
  if (!guard.ok) return guard.response;

  const parsed = await readCreateInput(request);
  if (!parsed.ok) return parsed.response;

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");

    const scopedOffer = await client.query<{
      id: string;
      destinationAvailable: boolean;
    }>(
      `SELECT offer.id::text,
              (tenant.status = 'active'
                AND offer.status = 'active'
                AND (offer.expires_at IS NULL
                  OR offer.expires_at > clock_timestamp())
                AND canonical_store.status = 'active'
                AND canonical_store.visibility = 'public'
                AND scoped_domain.status = 'active') AS "destinationAvailable"
         FROM marketplace_offers offer
         JOIN tenants tenant
           ON tenant.id = offer.tenant_id
         JOIN stores canonical_store
           ON canonical_store.tenant_id = offer.tenant_id
          AND canonical_store.domain_id = offer.domain_id
          AND canonical_store.id = offer.store_id
         JOIN domains scoped_domain
           ON scoped_domain.tenant_id = canonical_store.tenant_id
          AND scoped_domain.id = canonical_store.domain_id
        WHERE offer.tenant_id = $1::uuid
          AND offer.store_id = $2::uuid
          AND offer.domain_id = $3::uuid
          AND offer.id = $4::uuid
        FOR KEY SHARE OF offer, tenant, canonical_store, scoped_domain`,
      [
        guard.value.tenantId,
        storeId,
        guard.value.store.domainId,
        parsed.value.offerId,
      ],
    );
    const scopedTarget = scopedOffer.rows[0];
    if (!scopedTarget) {
      await client.query("ROLLBACK");
      return error("商品不属于当前店铺", 400);
    }

    const rawToken = generateAcquisitionToken();
    const linkId = randomUUID();
    const inserted = await client.query<LinkRow>(
      `INSERT INTO marketplace_acquisition_links
         (id, tenant_id, domain_id, store_id, offer_id, token_digest,
          channel_key, source_ref, campaign_ref, status, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bytea,
               $7, $8, $9, 'active', $10::timestamptz)
       RETURNING id::text,
                 offer_id::text AS "offerId",
                 channel_key AS "channelKey",
                 source_ref AS "sourceRef",
                 campaign_ref AS "campaignRef",
                 status AS "configuredStatus",
                 expires_at::text AS "expiresAt",
                 (expires_at IS NOT NULL
                   AND expires_at <= clock_timestamp()) AS expired,
                 version::text,
                 created_at::text AS "createdAt",
                 updated_at::text AS "updatedAt"`,
      [
        linkId,
        guard.value.tenantId,
        guard.value.store.domainId,
        storeId,
        parsed.value.offerId,
        digestAcquisitionToken(rawToken),
        parsed.value.channelKey,
        parsed.value.sourceRef,
        parsed.value.campaignRef,
        parsed.value.expiresAt,
      ],
    );
    const link = inserted.rows[0];
    if (!link) throw new Error("acquisition link insert returned no row");

    await client.query(
      `INSERT INTO platform_audit_events
         (id, tenant_id, domain_id, platform_path, actor_auth_user_id,
          event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
               'store.acquisition_link.created', 'success', $6::jsonb)`,
      [
        randomUUID(),
        guard.value.tenantId,
        guard.value.store.domainId,
        guard.value.store.path,
        guard.value.session.user.id,
        JSON.stringify({
          store_id: storeId,
          link_id: link.id,
          offer_id: link.offerId,
          channel_key: link.channelKey,
          status: "active",
          version: Number(link.version),
          expires_at: link.expiresAt,
        }),
      ],
    );
    await client.query("COMMIT");

    return NextResponse.json(
      {
        link: linkMetadata(link, scopedTarget.destinationAvailable),
        shortPath: `/r/${rawToken}`,
      },
      {
        status: 201,
        headers: {
          ...privateHeaders(),
          "referrer-policy": "no-referrer",
        },
      },
    );
  } catch {
    await rollbackAfterFailure(client);
    return error("渠道链接创建失败，请稍后重试", 500);
  } finally {
    client?.release();
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return error("请求来源未被商城信任", 403);
  }
  const { storeId } = await context.params;
  const guard = await requireStoreManager(request, storeId);
  if (!guard.ok) return guard.response;

  const parsed = await readStatusInput(request);
  if (!parsed.ok) return parsed.response;

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const locked = await client.query<LinkRow>(
      `SELECT link.id::text,
              link.offer_id::text AS "offerId",
              link.channel_key AS "channelKey",
              link.source_ref AS "sourceRef",
              link.campaign_ref AS "campaignRef",
              link.status AS "configuredStatus",
              link.expires_at::text AS "expiresAt",
              (link.expires_at IS NOT NULL
                AND link.expires_at <= statement_timestamp()) AS expired,
              (tenant.status = 'active'
                AND offer.status = 'active'
                AND (offer.expires_at IS NULL
                  OR offer.expires_at > statement_timestamp())
                AND canonical_store.status = 'active'
                AND canonical_store.visibility = 'public'
                AND scoped_domain.status = 'active') AS "destinationAvailable",
              link.version::text,
              link.created_at::text AS "createdAt",
              link.updated_at::text AS "updatedAt"
         FROM marketplace_acquisition_links link
         JOIN tenants tenant
           ON tenant.id = link.tenant_id
         JOIN marketplace_offers offer
           ON offer.tenant_id = link.tenant_id
          AND offer.domain_id = link.domain_id
          AND offer.store_id = link.store_id
          AND offer.id = link.offer_id
         JOIN stores canonical_store
           ON canonical_store.tenant_id = link.tenant_id
          AND canonical_store.domain_id = link.domain_id
          AND canonical_store.id = link.store_id
         JOIN domains scoped_domain
           ON scoped_domain.tenant_id = link.tenant_id
          AND scoped_domain.id = link.domain_id
        WHERE link.tenant_id = $1::uuid
          AND link.store_id = $2::uuid
          AND link.id = $3::uuid
        FOR UPDATE OF link`,
      [guard.value.tenantId, storeId, parsed.value.linkId],
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return error("没有找到这条渠道链接", 404);
    }
    if (Number(current.version) !== parsed.value.expectedVersion) {
      await client.query("ROLLBACK");
      return error("渠道链接已被其他操作更新，请刷新后重试", 409);
    }
    if (parsed.value.status === "active" && current.expired) {
      await client.query("ROLLBACK");
      return error("已过期的渠道链接不能重新启用", 409);
    }

    const updated = await client.query<LinkRow>(
      `UPDATE marketplace_acquisition_links link
          SET status = $4,
              version = link.version + 1,
              updated_at = clock_timestamp()
        WHERE link.tenant_id = $1::uuid
          AND link.store_id = $2::uuid
          AND link.id = $3::uuid
          AND link.version = $5::bigint
       RETURNING link.id::text,
                 link.offer_id::text AS "offerId",
                 link.channel_key AS "channelKey",
                 link.source_ref AS "sourceRef",
                 link.campaign_ref AS "campaignRef",
                 link.status AS "configuredStatus",
                 link.expires_at::text AS "expiresAt",
                 (link.expires_at IS NOT NULL
                   AND link.expires_at <= clock_timestamp()) AS expired,
                 link.version::text,
                 link.created_at::text AS "createdAt",
                 link.updated_at::text AS "updatedAt"`,
      [
        guard.value.tenantId,
        storeId,
        parsed.value.linkId,
        parsed.value.status,
        parsed.value.expectedVersion,
      ],
    );
    const link = updated.rows[0];
    if (!link) throw new Error("locked acquisition link update returned no row");

    await client.query(
      `INSERT INTO platform_audit_events
         (id, tenant_id, domain_id, platform_path, actor_auth_user_id,
          event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
               'store.acquisition_link.status_updated', 'success', $6::jsonb)`,
      [
        randomUUID(),
        guard.value.tenantId,
        guard.value.store.domainId,
        guard.value.store.path,
        guard.value.session.user.id,
        JSON.stringify({
          store_id: storeId,
          link_id: link.id,
          previous_status: current.configuredStatus,
          status: link.configuredStatus,
          version: Number(link.version),
        }),
      ],
    );
    await client.query("COMMIT");
    return NextResponse.json(
      { link: linkMetadata(link, current.destinationAvailable) },
      { headers: privateHeaders() },
    );
  } catch {
    await rollbackAfterFailure(client);
    return error("渠道链接状态保存失败，请稍后重试", 500);
  } finally {
    client?.release();
  }
}

async function requireStoreManager(
  request: Request,
  storeId: string,
): Promise<ManagerGuard> {
  if (!isUuid(storeId)) {
    return { ok: false, response: error("店铺编号无效", 400) };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { ok: false, response: error("请先登录", 401) };
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store || !access.canManageStore) {
    return {
      ok: false,
      response: error("只有店主或商城后台可以管理渠道链接", 403),
    };
  }
  const tenantId = configuredTenantId();
  if (!tenantId || access.store.tenantId !== tenantId) {
    return { ok: false, response: error("商城尚未完成初始化", 503) };
  }
  return {
    ok: true,
    value: {
      session: session as ManagerContext["session"],
      store: access.store,
      tenantId,
    },
  };
}

async function readCreateInput(
  request: Request,
): Promise<
  | {
      ok: true;
      value: {
        offerId: string;
        channelKey: string;
        sourceRef: string | null;
        campaignRef: string | null;
        expiresAt: string | null;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await readObjectBody(request);
  if (!body.ok) return body;
  if (
    !hasOnlyKeys(body.value, [
      "offerId",
      "channelKey",
      "sourceRef",
      "campaignRef",
      "expiresAt",
    ])
  ) {
    return { ok: false, response: error("渠道链接包含不支持的字段", 400) };
  }
  if (typeof body.value.offerId !== "string" || !isUuid(body.value.offerId)) {
    return { ok: false, response: error("商品编号必须是 UUID", 400) };
  }
  const channelKey =
    typeof body.value.channelKey === "string"
      ? body.value.channelKey.trim()
      : "";
  if (!CHANNEL_KEY_PATTERN.test(channelKey)) {
    return {
      ok: false,
      response: error(
        "channelKey 必须是 1 到 64 位小写规范键",
        400,
      ),
    };
  }
  const sourceRef = optionalReference(body.value.sourceRef);
  if (!sourceRef.ok) {
    return {
      ok: false,
      response: error("sourceRef 必须是 1 到 128 个安全字符", 400),
    };
  }
  const campaignRef = optionalReference(body.value.campaignRef);
  if (!campaignRef.ok) {
    return {
      ok: false,
      response: error("campaignRef 必须是 1 到 128 个安全字符", 400),
    };
  }
  const expiresAt = optionalFutureTimestamp(body.value.expiresAt);
  if (!expiresAt.ok) {
    return {
      ok: false,
      response: error("expiresAt 必须是未来的 ISO 8601 时间", 400),
    };
  }
  return {
    ok: true,
    value: {
      offerId: body.value.offerId,
      channelKey,
      sourceRef: sourceRef.value,
      campaignRef: campaignRef.value,
      expiresAt: expiresAt.value,
    },
  };
}

async function readStatusInput(
  request: Request,
): Promise<
  | {
      ok: true;
      value: {
        linkId: string;
        status: ConfiguredLinkStatus;
        expectedVersion: number;
      };
    }
  | { ok: false; response: Response }
> {
  const body = await readObjectBody(request);
  if (!body.ok) return body;
  if (!hasOnlyKeys(body.value, ["linkId", "status", "expectedVersion"])) {
    return { ok: false, response: error("渠道链接状态包含不支持的字段", 400) };
  }
  if (typeof body.value.linkId !== "string" || !isUuid(body.value.linkId)) {
    return { ok: false, response: error("渠道链接编号必须是 UUID", 400) };
  }
  if (body.value.status !== "active" && body.value.status !== "disabled") {
    return {
      ok: false,
      response: error("status 只能是 active 或 disabled", 400),
    };
  }
  if (
    !Number.isSafeInteger(body.value.expectedVersion) ||
    Number(body.value.expectedVersion) < 1
  ) {
    return {
      ok: false,
      response: error("渠道链接版本无效，请刷新后重试", 400),
    };
  }
  return {
    ok: true,
    value: {
      linkId: body.value.linkId,
      status: body.value.status,
      expectedVersion: Number(body.value.expectedVersion),
    },
  };
}

async function readObjectBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  try {
    const value = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, response: error("请求必须是 JSON 对象", 400) };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (cause) {
    return {
      ok: false,
      response: error(
        cause instanceof RequestBodyTooLargeError
          ? "请求体不能超过 16 KiB"
          : "请求必须是有效 JSON",
        cause instanceof RequestBodyTooLargeError ? 413 : 400,
      ),
    };
  }
}

function optionalReference(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > MAX_REF_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return { ok: false };
  }
  return { ok: true, value: normalized };
}

function optionalFutureTimestamp(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > 64) return { ok: false };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    return { ok: false };
  }
  return { ok: true, value: new Date(timestamp).toISOString() };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function linkMetadata(
  row: LinkRow,
  destinationAvailable = row.destinationAvailable ?? false,
) {
  let status: "active" | "disabled" | "expired" = "active";
  if (row.configuredStatus === "disabled") status = "disabled";
  else if (row.expired) status = "expired";

  const effectiveStatus: EffectiveLinkStatus =
    status === "disabled"
      ? "disabled"
      : status === "expired"
        ? "expired"
        : destinationAvailable
          ? "active"
          : "unavailable";
  const unavailableReason: LinkUnavailableReason =
    effectiveStatus === "active"
      ? null
      : effectiveStatus === "unavailable"
        ? "destination_unavailable"
        : effectiveStatus;

  return {
    id: row.id,
    offerId: row.offerId,
    channelKey: row.channelKey,
    sourceRef: row.sourceRef,
    campaignRef: row.campaignRef,
    status,
    active: effectiveStatus === "active",
    effectiveStatus,
    unavailableReason,
    expiresAt: row.expiresAt,
    version: Number(row.version),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rollbackAfterFailure(client: PoolClient | undefined): Promise<unknown> {
  if (!client) return Promise.resolve();
  return client.query("ROLLBACK").catch(() => undefined);
}

function privateHeaders(): Record<string, string> {
  return { "cache-control": "no-store, private", pragma: "no-cache" };
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: privateHeaders() },
  );
}
