import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { isUuid } from "../../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  const { mediaId } = await context.params;
  if (!isUuid(mediaId)) return notFound();
  const configuredRoot = process.env.MATCHPLANE_HOSTED_MEDIA_ROOT?.trim() ?? "";
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    return NextResponse.json({ error: "托管图片存储尚未配置" }, { status: 503 });
  }

  const result = await authDatabase.query<{
    storageKey: string;
    fileName: string;
    mediaType: string;
    sizeBytes: string;
    tenantId: string;
    storeId: string;
    organizationId: string;
    status: string;
    activeReference: boolean;
  }>(
    `SELECT media.storage_key AS "storageKey",
            media.file_name AS "fileName",
            media.media_type AS "mediaType",
            media.size_bytes::text AS "sizeBytes",
            media.tenant_id::text AS "tenantId",
            media.store_id::text AS "storeId",
            store.organization_id::text AS "organizationId",
            media.status,
            EXISTS (
              SELECT 1
                FROM marketplace_offers offer
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(offer.attributes -> 'attachments') = 'array'
                       THEN offer.attributes -> 'attachments' ELSE '[]'::jsonb END
                ) attachment
               WHERE offer.tenant_id = media.tenant_id
                 AND offer.store_id = media.store_id
                 AND offer.status = 'active'
                 AND attachment ->> 'attachment_ref' = 'media://hosted/' || media.id::text
            ) AS "activeReference"
       FROM hosted_store_media media
       JOIN stores store
         ON store.tenant_id = media.tenant_id AND store.id = media.store_id
      WHERE media.id = $1::uuid
        AND media.status IN ('pending', 'published')
        AND store.status = 'active'
        AND store.visibility = 'public'
      LIMIT 1`,
    [mediaId],
  );
  const media = result.rows[0];
  if (!media || !/^[0-9a-f-]{36}\.[a-z0-9]{2,8}$/.test(media.storageKey)) return notFound();
  const publicMedia = media.status === "published" && media.activeReference;
  if (!publicMedia && !(await mayPreviewStoreMedia(request, media.organizationId))) return notFound();

  try {
    const root = await realpath(/* turbopackIgnore: true */ configuredRoot);
    const candidate = await realpath(/* turbopackIgnore: true */ path.join(root, media.tenantId, media.storeId, media.storageKey));
    if (!candidate.startsWith(`${root}${path.sep}`)) return notFound();
    const bytes = await readFile(candidate);
    if (bytes.byteLength !== Number(media.sizeBytes)) return notFound();
    return new Response(bytes, {
      headers: {
        "cache-control": publicMedia ? "public, max-age=60, s-maxage=300, must-revalidate" : "private, no-store",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.fileName)}`,
        "content-length": String(bytes.byteLength),
        "content-type": media.mediaType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return notFound();
  }
}

async function mayPreviewStoreMedia(request: Request, organizationId: string): Promise<boolean> {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return false;
  const role = (session.user as { role?: unknown }).role;
  if (role === "rootSuperAdmin" || role === "rootAdmin") return true;
  const member = await authDatabase.query(
    `SELECT 1 FROM "member"
      WHERE "organizationId" = $1::uuid
        AND "userId" = $2::uuid
        AND role = ANY($3::text[])
      LIMIT 1`,
    [organizationId, session.user.id, ["owner", "admin", "subplatform_admin"]],
  );
  return member.rowCount === 1;
}

function notFound(): Response {
  return NextResponse.json({ error: "图片不存在" }, { status: 404, headers: { "cache-control": "no-store" } });
}
