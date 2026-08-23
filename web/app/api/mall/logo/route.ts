import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import {
  ManagedImageError,
  persistManagedImage,
  readManagedImage,
  removeManagedImage,
} from "../../../../src/lib/managed-image";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { jsonError } from "../../../../src/lib/json-error";
import { configuredTenantId } from "../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, cache-safe serving endpoint for the active marketplace brand mark. */
export async function GET(): Promise<Response> {
  const tenantId = configuredTenantId();
  if (!tenantId) return notFound();
  const result = await authDatabase.query<{ logoKey: string | null }>(
    `SELECT brand_logo_key AS "logoKey" FROM tenants WHERE id = $1::uuid AND status = 'active' LIMIT 1`,
    [tenantId],
  );
  const bytes = await readManagedImage(
    result.rows[0]?.logoKey ?? null,
    "brand",
  );
  if (!bytes) return notFound();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
      "content-length": String(bytes.byteLength),
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Only the marketplace owner may replace the shared public brand mark. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  if ((session.user as { role?: unknown }).role !== "rootSuperAdmin") {
    return jsonError("只有商城负责人可以修改品牌 Logo", 403);
  }
  let input: { dataBase64?: unknown; expectedVersion?: unknown };
  try {
    input = (await readJsonBody(request, 6 * 1024 * 1024)) as typeof input;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "Logo 图片不能超过 4 MiB"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (typeof input.dataBase64 !== "string")
    return jsonError("请上传有效的 Logo 图片", 400);
  const expectedVersion =
    typeof input.expectedVersion === "number" &&
    Number.isSafeInteger(input.expectedVersion) &&
    input.expectedVersion > 0
      ? input.expectedVersion
      : null;
  if (!expectedVersion) return jsonError("expectedVersion 必须是正整数", 400);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  let image: { key: string; bytes: number };
  try {
    image = await persistManagedImage({
      scope: "brand",
      ownerId: tenantId,
      dataBase64: input.dataBase64,
    });
  } catch (error) {
    return jsonError(
      error instanceof ManagedImageError ? error.message : "Logo 保存失败",
      400,
    );
  }

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const updated = await client.query<MallRow>(
      `UPDATE tenants
          SET brand_logo_key = $2, version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1::uuid AND version = $3::bigint AND status = 'active'
        RETURNING name, slug, version::text`,
      [tenantId, image.key, expectedVersion],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      await removeManagedImage(image.key, "brand");
      return jsonError("商城品牌已被其他人更新，请刷新后重试", 409);
    }
    await client.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, '/', $3::uuid, 'mall.brand.logo.updated', 'success', $4::jsonb)`,
      [
        randomUUID(),
        tenantId,
        session.user.id,
        JSON.stringify({ bytes: image.bytes }),
      ],
    );
    await client.query("COMMIT");
    const mall = updated.rows[0]!;
    return NextResponse.json(
      {
        mall: {
          name: mall.name,
          slug: mall.slug,
          version: Number(mall.version),
          logoUrl: `/api/mall/logo?v=${mall.version}`,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    await removeManagedImage(image.key, "brand");
    console.error("mall brand logo update failed", error);
    return jsonError("Logo 保存失败", 500);
  } finally {
    client?.release();
  }
}

interface MallRow {
  name: string;
  slug: string;
  version: string;
}



function notFound(): Response {
  return NextResponse.json(
    { error: "Logo 尚未设置" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}
