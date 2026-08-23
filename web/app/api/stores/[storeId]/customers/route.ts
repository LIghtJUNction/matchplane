import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  readStoreAccess,
  roleOf,
} from "../../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAD_STAGES = new Set([
  "new",
  "discovering",
  "qualified",
  "contact_requested",
  "contact_exchanged",
  "won",
  "lost",
]);

type RouteContext = { params: Promise<{ storeId: string }> };

type CustomerProductRow = {
  id: string;
  displayName: string;
  attributes: unknown;
  terms: unknown;
};

type CustomerRow = {
  id: string;
  participantId: string;
  displayName: string | null;
  avatarUrl: string | null;
  summary: unknown;
  handoffStatus: string;
  stage: string;
  favorite: boolean;
  contactConsentStatus: string;
  staffNotes: string | null;
  lastActivityAt: string;
  createdAt: string;
  version: string | number;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const access = await requireStoreOperator(request, context);
  if (access instanceof Response) return access;

  const rows = await authDatabase.query<CustomerRow>(
    `SELECT DISTINCT ON (handoff.participant_id)
            handoff.id::text,
            handoff.participant_id::text AS "participantId",
            account.name AS "displayName",
            account.image AS "avatarUrl",
            handoff.summary,
            handoff.status AS "handoffStatus",
            handoff.lead_stage AS stage,
            handoff.favorite,
            handoff.contact_consent_status AS "contactConsentStatus",
            handoff.staff_notes AS "staffNotes",
            handoff.last_activity_at::text AS "lastActivityAt",
            handoff.created_at::text AS "createdAt",
            handoff.version::text
       FROM marketplace_sales_handoffs handoff
       LEFT JOIN marketplace_party_auth_links party_link
         ON party_link.tenant_id = handoff.tenant_id
        AND party_link.party_id = handoff.participant_id
       LEFT JOIN "user" account
         ON account.id = party_link.auth_user_id
      WHERE handoff.domain_id = $1::uuid
      ORDER BY handoff.participant_id,
               handoff.favorite DESC,
               handoff.last_activity_at DESC,
               handoff.id DESC`,
    [access.domainId],
  );

  const serialized = rows.rows.map(serializeCustomer);
  const offerIds = [
    ...new Set(
      serialized.flatMap((customer) =>
        customer.productIds.filter((id) => UUID_PATTERN.test(id)),
      ),
    ),
  ];
  const products = offerIds.length
    ? await authDatabase.query<CustomerProductRow>(
        `SELECT id::text,
                display_name AS "displayName",
                attributes,
                terms
           FROM marketplace_offers
          WHERE domain_id = $1::uuid
            AND id = ANY($2::uuid[])`,
        [access.domainId, offerIds],
      )
    : { rows: [] as CustomerProductRow[] };
  const productsById = new Map(
    products.rows.map((product) => [product.id, serializeProduct(product)]),
  );
  const customers = serialized
    .map((customer) => ({
      ...customer,
      products: customer.productIds.flatMap((id) => {
        const product = productsById.get(id);
        return product ? [product] : [];
      }),
    }))
    .sort(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) ||
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
  return NextResponse.json(
    { customers },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return problem("请求来源不受信任", 403);
  const access = await requireStoreOperator(request, context);
  if (access instanceof Response) return access;

  let body: {
    id?: unknown;
    favorite?: unknown;
    stage?: unknown;
    staffNotes?: unknown;
    expectedVersion?: unknown;
  };
  try {
    body = (await readJsonBody(request, 8 * 1024)) as typeof body;
  } catch (cause) {
    return problem(
      cause instanceof RequestBodyTooLargeError
        ? "客户更新内容不能超过 8 KiB"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }

  if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id))
    return problem("客户记录编号无效", 400);
  if (body.favorite !== undefined && typeof body.favorite !== "boolean")
    return problem("收藏状态无效", 400);
  if (
    body.stage !== undefined &&
    (typeof body.stage !== "string" || !LEAD_STAGES.has(body.stage))
  )
    return problem("客户阶段无效", 400);
  if (
    body.staffNotes !== undefined &&
    body.staffNotes !== null &&
    (typeof body.staffNotes !== "string" || body.staffNotes.length > 2000)
  )
    return problem("跟进备注不能超过 2000 个字符", 400);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    return problem("客户记录版本无效", 400);
  if (
    body.favorite === undefined &&
    body.stage === undefined &&
    body.staffNotes === undefined
  )
    return problem("没有可更新的客户字段", 400);

  const result = await authDatabase.query<CustomerRow>(
    `UPDATE marketplace_sales_handoffs
        SET favorite = COALESCE($3::boolean, favorite),
            lead_stage = COALESCE($4::text, lead_stage),
            staff_notes = CASE WHEN $5::boolean THEN $6::text ELSE staff_notes END,
            last_activity_at = clock_timestamp(),
            version = version + 1
      WHERE id = $1::uuid
        AND domain_id = $2::uuid
        AND version = $7::bigint
      RETURNING id::text,
                participant_id::text AS "participantId",
                NULL::text AS "displayName",
                NULL::text AS "avatarUrl",
                summary,
                status AS "handoffStatus",
                lead_stage AS stage,
                favorite,
                contact_consent_status AS "contactConsentStatus",
                staff_notes AS "staffNotes",
                last_activity_at::text AS "lastActivityAt",
                created_at::text AS "createdAt",
                version::text`,
    [
      body.id,
      access.domainId,
      body.favorite ?? null,
      body.stage ?? null,
      body.staffNotes !== undefined,
      typeof body.staffNotes === "string" ? body.staffNotes.trim() || null : null,
      expectedVersion,
    ],
  );
  const row = result.rows[0];
  if (!row) return problem("客户记录已更新，请刷新后重试", 409);
  return NextResponse.json(
    { customer: serializeCustomer(row) },
    { headers: { "cache-control": "no-store" } },
  );
}

async function requireStoreOperator(request: Request, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return problem("请先登录", 401);
  const { storeId } = await context.params;
  if (!UUID_PATTERN.test(storeId)) return problem("店铺编号无效", 400);
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store) return problem("店铺不存在", 404);
  if (!access.canOperate) return problem("没有客户跟进权限", 403);
  return { domainId: access.store.domainId };
}

function serializeCustomer(row: CustomerRow) {
  const summary = asRecord(row.summary);
  const productIds = stringList(summary.product_ids, 12, 128);
  const analysis = boundedText(
    summary.analysis ?? summary.narrative ?? summary.reason,
    1200,
  );
  const intent = boundedText(summary.intent_strength, 24);
  return {
    id: row.id,
    participantId: row.participantId,
    displayName:
      boundedText(row.displayName, 80) || `客户 ${row.participantId.slice(0, 6)}`,
    avatarUrl: safeImageUrl(row.avatarUrl),
    analysis,
    intent: ["warm", "high", "urgent"].includes(intent) ? intent : "warm",
    productIds,
    products: [] as Array<{
      id: string;
      name: string;
      imageUrl: string | null;
      price: string;
    }>,
    handoffStatus: row.handoffStatus,
    stage: row.stage,
    favorite: row.favorite,
    contactConsentStatus: row.contactConsentStatus,
    staffNotes: row.staffNotes,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    version: Number(row.version),
  };
}

function serializeProduct(row: CustomerProductRow) {
  const attributes = asRecord(row.attributes);
  const terms = asRecord(row.terms);
  return {
    id: row.id,
    name: row.displayName,
    imageUrl: safeImageUrl(attributes.image_url ?? attributes.imageUrl),
    price: boundedText(terms.display_price ?? terms.price, 80),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.length > 0 && item.length <= maxLength,
    )
    .slice(0, limit);
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("/api/profile/avatar")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function problem(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
