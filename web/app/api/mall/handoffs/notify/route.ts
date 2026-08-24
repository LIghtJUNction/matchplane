import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HandoffRow = {
  handoffId: string;
  storeId: string;
  storePath: string;
  storeName: string;
  organizationId: string;
  summary: unknown;
};

export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return problem("请求来源不受信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return problem("请先登录", 401);
  let body: { handoffId?: unknown; storePath?: unknown };
  try {
    body = (await readJsonBody(request, 2 * 1024)) as typeof body;
  } catch (cause) {
    return problem(
      cause instanceof RequestBodyTooLargeError
        ? "通知请求不能超过 2 KiB"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (typeof body.handoffId !== "string" || !UUID_PATTERN.test(body.handoffId))
    return problem("人工介入记录无效", 400);
  if (
    typeof body.storePath !== "string" ||
    !/^\/[a-z0-9][a-z0-9-]{1,62}$/.test(body.storePath)
  )
    return problem("店铺地址无效", 400);

  const handoff = await authDatabase.query<HandoffRow>(
    `SELECT handoff.id::text AS "handoffId",
            store.id::text AS "storeId",
            ('/' || store.slug) AS "storePath",
            store.display_name AS "storeName",
            store.organization_id::text AS "organizationId",
            handoff.summary
       FROM marketplace_sales_handoffs handoff
       JOIN stores store
         ON ('/' || store.slug) = $1
        AND store.tenant_id = handoff.tenant_id
        AND store.domain_id = handoff.domain_id
        AND store.status = 'active'
        AND store.visibility = 'public'
       JOIN marketplace_party_auth_links party_link
         ON party_link.tenant_id = handoff.tenant_id
        AND party_link.party_id = handoff.participant_id
        AND party_link.auth_user_id = $3::uuid
      WHERE handoff.id = $2::uuid`,
    [body.storePath, body.handoffId, session.user.id],
  );
  const record = handoff.rows[0];
  if (!record) return problem("没有找到可通知的人工介入记录", 404);

  const recipients = await authDatabase.query<{ userId: string }>(
    `SELECT DISTINCT member."userId"::text AS "userId"
       FROM "member" member
      WHERE member."organizationId" = $1
        AND member.role IN ('owner', 'admin', 'subplatform_admin')`,
    [record.organizationId],
  );
  const summary = asRecord(record.summary);
  const analysis = boundedText(summary.analysis, 420);
  const payload = {
    storeId: record.storeId,
    handoffId: record.handoffId,
    intent: boundedText(summary.intent_strength, 24) || "warm",
    productIds: stringList(summary.product_ids, 6, 128),
  };

  await Promise.all(
    recipients.rows.map((recipient) =>
      authDatabase.query(
        `INSERT INTO user_notifications (
           id,
           recipient_auth_user_id,
           platform_path,
           kind,
           source_type,
           source_id,
           title,
           body,
           payload,
           action_path
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3,
           'customer_intent',
           'store_ai_handoff',
           $4,
           $5,
           $6,
           $7::jsonb,
           $8
         )
         ON CONFLICT (recipient_auth_user_id, source_type, source_id, kind)
         DO NOTHING`,
        [
          randomUUID(),
          recipient.userId,
          record.storePath,
          record.handoffId,
          `“${record.storeName}”有客户请求店员介入`,
          analysis || "AI 店长识别到新的客户意向，请及时查看。",
          JSON.stringify(payload),
          `/?storeConsole=${encodeURIComponent(record.storeId)}&storeConsoleSection=customers`,
        ],
      ),
    ),
  );

  return NextResponse.json(
    { notified: recipients.rows.length },
    { headers: { "cache-control": "no-store" } },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function stringList(
  value: unknown,
  limit: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.length > 0 && item.length <= maxLength,
    )
    .slice(0, limit);
}

function problem(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
