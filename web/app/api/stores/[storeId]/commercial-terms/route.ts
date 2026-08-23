import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { isUuid } from "../../../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PricingModel = "none" | "subscription" | "commission" | "hybrid";
type BillingInterval = "month" | "year" | null;

interface CommercialTermsInput {
  pricingModel?: unknown;
  recurringFeeMinor?: unknown;
  currency?: unknown;
  billingInterval?: unknown;
  commissionBps?: unknown;
  status?: unknown;
  expectedVersion?: unknown;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || (session.user as { role?: unknown }).role !== "rootSuperAdmin") {
    return error("只有商城负责人可以修改店铺计费", 403);
  }
  const { storeId } = await context.params;
  if (!isUuid(storeId)) return error("店铺编号无效", 400);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(tenantId)) return error("商城尚未完成初始化", 503);

  let body: CommercialTermsInput;
  try {
    body = await readJsonBody(request, 16 * 1024) as CommercialTermsInput;
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "请求体不能超过 16 KiB" : "请求必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const parsed = parseTerms(body);
  if (!parsed.ok) return error(parsed.error, 400);

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const updated = await client.query<CommercialTermsRow>(
      `UPDATE store_commercial_terms terms
          SET pricing_model = $3,
              recurring_fee_minor = $4::numeric,
              currency = $5,
              billing_interval = $6,
              commission_bps = $7,
              status = $8,
              version = version + 1
         FROM stores store
        WHERE terms.tenant_id = $1::uuid
          AND terms.store_id = $2::uuid
          AND terms.version = $9
          AND store.tenant_id = terms.tenant_id
          AND store.id = terms.store_id
          AND store.status <> 'closed'
      RETURNING terms.pricing_model AS "pricingModel",
                terms.recurring_fee_minor::text AS "recurringFeeMinor",
                terms.currency,
                terms.billing_interval AS "billingInterval",
                terms.commission_bps AS "commissionBps",
                terms.status,
                terms.version,
                store.domain_id::text AS "domainId",
                store.slug`,
      [tenantId, storeId, parsed.value.pricingModel, parsed.value.recurringFeeMinor, parsed.value.currency, parsed.value.billingInterval, parsed.value.commissionBps, parsed.value.status, parsed.value.expectedVersion],
    );
    const terms = updated.rows[0];
    if (!terms) {
      await client.query("ROLLBACK");
      return error("店铺计费已被其他操作更新，请刷新后重试", 409);
    }
    await client.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, domain_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'store.commercial_terms.updated', 'success', $6::jsonb)`,
      [randomUUID(), tenantId, terms.domainId, `/${terms.slug}`, session.user.id, JSON.stringify({ store_id: storeId, pricing_model: terms.pricingModel, status: terms.status, version: terms.version })],
    );
    await client.query("COMMIT");
    return NextResponse.json({ commercialTerms: responseTerms(terms) }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("store commercial terms update failed", cause);
    return error("店铺计费保存失败，请稍后重试", 500);
  } finally {
    client?.release();
  }
}

function parseTerms(input: CommercialTermsInput):
  | { ok: true; value: { pricingModel: PricingModel; recurringFeeMinor: string; currency: string; billingInterval: BillingInterval; commissionBps: number; status: "draft" | "paused"; expectedVersion: number } }
  | { ok: false; error: string } {
  const pricingModel = input.pricingModel;
  const recurringFeeMinor = input.recurringFeeMinor;
  const currency = input.currency;
  const billingInterval = input.billingInterval;
  const commissionBps = input.commissionBps;
  const status = input.status;
  const expectedVersion = input.expectedVersion;
  if (pricingModel !== "none" && pricingModel !== "subscription" && pricingModel !== "commission" && pricingModel !== "hybrid") return { ok: false, error: "请选择有效的计费方式" };
  if (typeof recurringFeeMinor !== "string" || !/^[0-9]{1,38}$/.test(recurringFeeMinor)) return { ok: false, error: "固定租金格式无效" };
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "币种必须是三位大写代码" };
  if (billingInterval !== null && billingInterval !== "month" && billingInterval !== "year") return { ok: false, error: "计费周期无效" };
  if (!Number.isSafeInteger(commissionBps) || Number(commissionBps) < 0 || Number(commissionBps) > 10_000) return { ok: false, error: "成交服务费必须在 0% 到 100% 之间" };
  if (status !== "draft" && status !== "paused") return { ok: false, error: "当前版本只保存计费草稿，尚未启用自动收费" };
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) return { ok: false, error: "计费版本无效" };
  const fee = BigInt(recurringFeeMinor);
  const commission = Number(commissionBps);
  const validCombination = pricingModel === "none"
    ? fee === 0n && billingInterval === null && commission === 0
    : pricingModel === "subscription"
      ? fee > 0n && billingInterval !== null && commission === 0
      : pricingModel === "commission"
        ? fee === 0n && billingInterval === null && commission > 0
        : fee > 0n && billingInterval !== null && commission > 0;
  if (!validCombination) return { ok: false, error: "租金、计费周期与成交服务费的组合不完整" };
  return { ok: true, value: { pricingModel, recurringFeeMinor, currency, billingInterval, commissionBps: commission, status, expectedVersion: Number(expectedVersion) } };
}

interface CommercialTermsRow {
  pricingModel: PricingModel;
  recurringFeeMinor: string;
  currency: string;
  billingInterval: BillingInterval;
  commissionBps: number;
  status: "draft" | "active" | "paused";
  version: number;
  domainId: string;
  slug: string;
}

function responseTerms(row: CommercialTermsRow): Omit<CommercialTermsRow, "domainId" | "slug"> {
  return {
    pricingModel: row.pricingModel,
    recurringFeeMinor: row.recurringFeeMinor,
    currency: row.currency,
    billingInterval: row.billingInterval,
    commissionBps: row.commissionBps,
    status: row.status,
    version: row.version,
  };
}

function error(message: string, status: number): Response {
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
