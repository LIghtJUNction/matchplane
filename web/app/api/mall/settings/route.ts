import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);
  const result = await authDatabase.query<MallRow>(
    `SELECT name,
            slug,
            version::text,
            brand_logo_key AS "logoKey",
            home_placeholder_phrases AS "placeholderPhrases",
            include_active_product_titles AS "includeActiveProductTitles"
       FROM tenants WHERE id = $1::uuid AND status = 'active' LIMIT 1`,
    [tenantId],
  );
  const mall = result.rows[0];
  if (!mall) return jsonError("商城不存在", 404);
  const activeProductTitles = mall.includeActiveProductTitles
    ? await readActiveProductTitles(tenantId)
    : [];
  return NextResponse.json(
    { mall: toPublicMall(mall, activeProductTitles) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  if ((session.user as { role?: unknown }).role !== "rootSuperAdmin") {
    return jsonError("只有商城负责人可以修改商城设置", 403);
  }
  let input: {
    name?: unknown;
    expectedVersion?: unknown;
    placeholderPhrases?: unknown;
    includeActiveProductTitles?: unknown;
  };
  try {
    const value = await readJsonBody(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request body must be an object");
    }
    input = value;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "请求体不能超过 16 KiB"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const expectedVersion =
    typeof input.expectedVersion === "number" &&
    Number.isSafeInteger(input.expectedVersion)
      ? input.expectedVersion
      : null;
  if (!name || name.length > 200)
    return jsonError("商城名称必须为 1 到 200 个字符", 400);
  if (!expectedVersion || expectedVersion < 1)
    return jsonError("expectedVersion 必须是正整数", 400);
  if (
    input.includeActiveProductTitles !== undefined &&
    typeof input.includeActiveProductTitles !== "boolean"
  ) {
    return jsonError("商品标题开关必须是布尔值", 400);
  }
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const current = await client.query<MallRow>(
      `SELECT name,
              slug,
              version::text,
              brand_logo_key AS "logoKey",
              home_placeholder_phrases AS "placeholderPhrases",
              include_active_product_titles AS "includeActiveProductTitles"
         FROM tenants WHERE id = $1::uuid FOR UPDATE`,
      [tenantId],
    );
    const currentMall = current.rows[0];
    if (!currentMall) {
      await client.query("ROLLBACK");
      return jsonError("商城不存在", 404);
    }
    const placeholderPhrases =
      input.placeholderPhrases === undefined
        ? normalizeStoredPhrases(currentMall.placeholderPhrases)
        : normalizePlaceholderPhrases(input.placeholderPhrases);
    if (!placeholderPhrases) {
      await client.query("ROLLBACK");
      return jsonError(
        "输入提示必须是最多 64 条、每条不超过 120 个字符的文本",
        400,
      );
    }
    const includeActiveProductTitles =
      input.includeActiveProductTitles === undefined
        ? currentMall.includeActiveProductTitles
        : input.includeActiveProductTitles === true;
    const updated = await client.query<MallRow>(
      `UPDATE tenants
          SET name = $2,
              home_placeholder_phrases = $4::jsonb,
              include_active_product_titles = $5,
              version = version + 1,
              updated_at = clock_timestamp()
        WHERE id = $1::uuid AND version = $3::bigint AND status = 'active'
        RETURNING name,
                  slug,
                  version::text,
                  brand_logo_key AS "logoKey",
                  home_placeholder_phrases AS "placeholderPhrases",
                  include_active_product_titles AS "includeActiveProductTitles"`,
      [
        tenantId,
        name,
        expectedVersion,
        JSON.stringify(placeholderPhrases),
        includeActiveProductTitles,
      ],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return jsonError("商城设置已被其他人更新，请刷新后重试", 409);
    }
    await client.query(
      `UPDATE "organization" SET name = $2
        WHERE "tenantId" = $1 AND "rootPlatform" = true AND "parentOrganizationId" IS NULL`,
      [tenantId, name],
    );
    await client.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, '/', $3::uuid, 'mall.settings.updated', 'success', $4::jsonb)`,
      [
        randomUUID(),
        tenantId,
        session.user.id,
        JSON.stringify({
          previous_name: currentMall.name,
          name,
          placeholder_phrase_count: placeholderPhrases.length,
          include_active_product_titles: includeActiveProductTitles,
        }),
      ],
    );
    const mall = updated.rows[0];
    const activeProductTitles = mall.includeActiveProductTitles
      ? await readActiveProductTitles(tenantId, client)
      : [];
    await client.query("COMMIT");
    return NextResponse.json(
      { mall: toPublicMall(mall, activeProductTitles) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("mall settings update failed", error);
    return jsonError("商城设置保存失败", 500);
  } finally {
    client?.release();
  }
}

interface MallRow {
  name: string;
  slug: string;
  version: string;
  logoKey: string | null;
  placeholderPhrases: unknown;
  includeActiveProductTitles: boolean;
}

function toPublicMall(row: MallRow, activeProductTitles: string[] = []) {
  const version = Number(row.version);
  const customPlaceholderPhrases = normalizeStoredPhrases(
    row.placeholderPhrases,
  );
  const placeholderPhrases = Array.from(
    new Set([...customPlaceholderPhrases, ...activeProductTitles]),
  );
  return {
    name: row.name,
    slug: row.slug,
    version,
    logoUrl: row.logoKey ? `/api/mall/logo?v=${version}` : null,
    customPlaceholderPhrases,
    includeActiveProductTitles: row.includeActiveProductTitles,
    activeProductTitleCount: activeProductTitles.length,
    placeholderPhrases,
  };
}

async function readActiveProductTitles(
  tenantId: string,
  client: PoolClient | typeof authDatabase = authDatabase,
): Promise<string[]> {
  const result = await client.query<{ title: string }>(
    `SELECT DISTINCT btrim(offer.display_name) AS title
       FROM marketplace_offers offer
       JOIN stores store
         ON store.tenant_id = offer.tenant_id
        AND store.id = offer.store_id
      WHERE offer.tenant_id = $1::uuid
        AND offer.status = 'active'
        AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
        AND store.status = 'active'
        AND store.visibility = 'public'
        AND length(btrim(offer.display_name)) > 0
      ORDER BY title`,
    [tenantId],
  );
  return result.rows.map((row) => row.title);
}

function normalizeStoredPhrases(value: unknown): string[] {
  return normalizePlaceholderPhrases(value) ?? [];
}

function normalizePlaceholderPhrases(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const phrase = item.trim();
    if (!phrase || phrase.length > 120) return null;
    if (!seen.has(phrase)) {
      seen.add(phrase);
      phrases.push(phrase);
    }
  }
  return phrases;
}

function configuredTenantId(): string | null {
  const value = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}
