import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  readJsonResponseBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { jsonError } from "../../../../src/lib/json-error";
import {
  hasOnlyPublicAddresses,
  isPrivateOrReservedIpLiteral,
} from "../../../../src/lib/public-endpoint";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { isProductionEnvironment } from "../../../../src/lib/runtime";
import { configuredTenantId } from "../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_CURRENCY = "USD";
const DEFAULT_LOCAL_CURRENCY = "CNY";
const DEFAULT_PROVIDER_URL = "https://api.frankfurter.app/latest";
const PROVIDER_RESPONSE_LIMIT = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 6_000;

interface StoredExchangeRate {
  localCurrency: string;
  usdToLocalRate: string | null;
  rateSource: string | null;
  rateUpdatedAt: unknown;
  version: string;
}

interface ExchangeRateInput {
  localCurrency: string;
  expectedVersion: number;
}

interface ExchangeRateResult {
  baseCurrency: typeof BASE_CURRENCY;
  localCurrency: string;
  usdToLocalRate: number | null;
  rateSource: string | null;
  rateUpdatedAt: string | null;
  version: number;
}

interface EditorContext {
  actorId: string;
}

class ExchangeRateProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ExchangeRateProviderError";
    this.status = status;
  }
}

class ExchangeRateConflictError extends Error {
  constructor() {
    super("currency settings version conflict");
    this.name = "ExchangeRateConflictError";
  }
}

export async function GET(): Promise<Response> {
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  try {
    const result = await authDatabase.query<StoredExchangeRate>(
      `SELECT COALESCE(currency.local_currency, $2) AS "localCurrency",
              currency.usd_to_local_rate::text AS "usdToLocalRate",
              currency.rate_source AS "rateSource",
              currency.rate_updated_at AS "rateUpdatedAt",
              COALESCE(currency.version, 1)::text AS version
         FROM tenants tenant
         LEFT JOIN mall_currency_settings currency
           ON currency.tenant_id = tenant.id
        WHERE tenant.id = $1::uuid
          AND tenant.status = 'active'
        LIMIT 1`,
      [tenantId, DEFAULT_LOCAL_CURRENCY],
    );
    const row = result.rows[0];
    if (!row) return jsonError("商城不存在", 404);

    return NextResponse.json(
      { exchangeRate: toPublicExchangeRate(row) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (isMissingCurrencySettingsTable(error)) {
      return jsonError("货币设置暂不可用；请确认数据库迁移已完成", 503);
    }
    console.error("mall exchange rate settings read failed", error);
    return jsonError("货币设置读取失败", 500);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const editor = await requireEditor(request);
  if (editor instanceof Response) return editor;

  const input = await readExchangeRateInput(request);
  if (input instanceof Response) return input;

  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  let client: PoolClient | undefined;
  try {
    const transactionClient = await authDatabase.connect();
    client = transactionClient;
    await transactionClient.query("BEGIN");

    if (!(await lockActiveTenant(transactionClient, tenantId))) {
      await transactionClient.query("ROLLBACK");
      return jsonError("商城不存在", 404);
    }

    const current = await readStoredExchangeRate(transactionClient, tenantId);
    if (exchangeRateVersion(current) !== input.expectedVersion) {
      await transactionClient.query("ROLLBACK");
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }

    if (current && current.localCurrency === input.localCurrency) {
      await transactionClient.query("COMMIT");
      return NextResponse.json(
        { exchangeRate: toPublicExchangeRate(current) },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const updated = await writeStoredExchangeRate({
      client: transactionClient,
      tenantId,
      current,
      localCurrency: input.localCurrency,
      usdToLocalRate: null,
      rateSource: null,
      actorId: editor.actorId,
    });
    await transactionClient.query("COMMIT");
    return NextResponse.json(
      { exchangeRate: toPublicExchangeRate(updated) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (isExchangeRateConflict(error)) {
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }
    if (isMissingCurrencySettingsTable(error)) {
      return jsonError("货币设置暂不可用；请确认数据库迁移已完成", 503);
    }
    console.error("mall exchange rate settings update failed", error);
    return jsonError("货币设置保存失败", 500);
  } finally {
    client?.release();
  }
}

export async function POST(request: Request): Promise<Response> {
  const editor = await requireEditor(request);
  if (editor instanceof Response) return editor;

  const input = await readExchangeRateInput(request);
  if (input instanceof Response) return input;

  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  let latest: { rate: number; source: string };
  try {
    latest = await fetchLatestUsdRate(input.localCurrency);
  } catch (error) {
    if (error instanceof ExchangeRateProviderError) {
      console.error("mall exchange rate provider failed", error.message);
      return jsonError(error.message, error.status);
    }
    console.error("mall exchange rate sync failed", error);
    return jsonError("最新美元汇率获取失败，请稍后重试", 502);
  }

  let client: PoolClient | undefined;
  try {
    const transactionClient = await authDatabase.connect();
    client = transactionClient;
    await transactionClient.query("BEGIN");

    if (!(await lockActiveTenant(transactionClient, tenantId))) {
      await transactionClient.query("ROLLBACK");
      return jsonError("商城不存在", 404);
    }

    const current = await readStoredExchangeRate(transactionClient, tenantId);
    if (exchangeRateVersion(current) !== input.expectedVersion) {
      await transactionClient.query("ROLLBACK");
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }

    const updated = await writeStoredExchangeRate({
      client: transactionClient,
      tenantId,
      current,
      localCurrency: input.localCurrency,
      usdToLocalRate: normalizeRateForStorage(latest.rate),
      rateSource: latest.source,
      actorId: editor.actorId,
    });
    await transactionClient.query("COMMIT");
    return NextResponse.json(
      { exchangeRate: toPublicExchangeRate(updated) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (isExchangeRateConflict(error)) {
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }
    if (isMissingCurrencySettingsTable(error)) {
      return jsonError("货币设置暂不可用；请确认数据库迁移已完成", 503);
    }
    console.error("mall exchange rate sync failed", error);
    return jsonError("最新美元汇率保存失败", 500);
  } finally {
    client?.release();
  }
}

async function requireEditor(
  request: Request,
): Promise<EditorContext | Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  if ((session.user as { role?: unknown }).role !== "rootSuperAdmin") {
    return jsonError("只有商城负责人可以修改货币设置", 403);
  }
  return { actorId: session.user.id };
}

async function readExchangeRateInput(
  request: Request,
): Promise<ExchangeRateInput | Response> {
  let value: unknown;
  try {
    value = await readJsonBody(request, 8 * 1024);
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "请求体不能超过 8 KiB"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return jsonError("请求体必须是对象", 400);
  }

  const input = value as Record<string, unknown>;
  const localCurrency = normalizeCurrency(input.localCurrency);
  if (!localCurrency) {
    return jsonError("本地货币必须是 3 位 ISO 4217 货币代码", 400);
  }
  const expectedVersion =
    typeof input.expectedVersion === "number" &&
    Number.isSafeInteger(input.expectedVersion) &&
    input.expectedVersion >= 1
      ? input.expectedVersion
      : null;
  if (expectedVersion === null) {
    return jsonError("expectedVersion 必须是正整数", 400);
  }
  return { localCurrency, expectedVersion };
}

async function lockActiveTenant(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
       FROM tenants
      WHERE id = $1::uuid AND status = 'active'
      FOR UPDATE`,
    [tenantId],
  );
  return result.rowCount === 1;
}

async function readStoredExchangeRate(
  client: PoolClient,
  tenantId: string,
): Promise<StoredExchangeRate | null> {
  const result = await client.query<StoredExchangeRate>(
    `SELECT local_currency AS "localCurrency",
            usd_to_local_rate::text AS "usdToLocalRate",
            rate_source AS "rateSource",
            rate_updated_at AS "rateUpdatedAt",
            version::text
       FROM mall_currency_settings
      WHERE tenant_id = $1::uuid
      FOR UPDATE`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

async function writeStoredExchangeRate(input: {
  client: PoolClient;
  tenantId: string;
  current: StoredExchangeRate | null;
  localCurrency: string;
  usdToLocalRate: string | null;
  rateSource: string | null;
  actorId: string;
}): Promise<StoredExchangeRate> {
  const nextVersion = exchangeRateVersion(input.current) + 1;
  if (!input.current) {
    const inserted = await input.client.query<StoredExchangeRate>(
      `INSERT INTO mall_currency_settings
         (tenant_id, local_currency, usd_to_local_rate, rate_source,
          rate_updated_at, version, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::numeric, $4,
               CASE WHEN $3::numeric IS NULL THEN NULL ELSE clock_timestamp() END,
               $5::bigint, clock_timestamp(), clock_timestamp())
       RETURNING local_currency AS "localCurrency",
                 usd_to_local_rate::text AS "usdToLocalRate",
                 rate_source AS "rateSource",
                 rate_updated_at AS "rateUpdatedAt",
                 version::text`,
      [
        input.tenantId,
        input.localCurrency,
        input.usdToLocalRate,
        input.rateSource,
        nextVersion,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("currency settings insert returned no row");
    await writeAuditEvent(input, null, row);
    return row;
  }

  const updated = await input.client.query<StoredExchangeRate>(
    `UPDATE mall_currency_settings
        SET local_currency = $2,
            usd_to_local_rate = $3::numeric,
            rate_source = $4,
            rate_updated_at = CASE
              WHEN $3::numeric IS NULL THEN NULL
              ELSE clock_timestamp()
            END,
            version = version + 1,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND version = $5::bigint
      RETURNING local_currency AS "localCurrency",
                usd_to_local_rate::text AS "usdToLocalRate",
                rate_source AS "rateSource",
                rate_updated_at AS "rateUpdatedAt",
                version::text`,
    [
      input.tenantId,
      input.localCurrency,
      input.usdToLocalRate,
      input.rateSource,
      input.current.version,
    ],
  );
  const row = updated.rows[0];
  if (!row) throw new ExchangeRateConflictError();
  await writeAuditEvent(input, input.current, row);
  return row;
}

async function writeAuditEvent(
  input: {
    client: PoolClient;
    tenantId: string;
    actorId: string;
  },
  previous: StoredExchangeRate | null,
  next: StoredExchangeRate,
): Promise<void> {
  await input.client.query(
    `INSERT INTO platform_audit_events
      (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
     VALUES ($1::uuid, $2::uuid, '/', $3::uuid,
             'mall.exchange_rate.updated', 'success', $4::jsonb)`,
    [
      randomUUID(),
      input.tenantId,
      input.actorId,
      JSON.stringify({
        previous_local_currency:
          previous?.localCurrency ?? DEFAULT_LOCAL_CURRENCY,
        local_currency: next.localCurrency,
        usd_to_local_rate: next.usdToLocalRate
          ? Number(next.usdToLocalRate)
          : null,
        rate_source: next.rateSource,
      }),
    ],
  );
}

async function fetchLatestUsdRate(
  localCurrency: string,
): Promise<{ rate: number; source: string }> {
  if (localCurrency === BASE_CURRENCY) {
    return { rate: 1, source: "identity" };
  }

  const usesDefaultProvider = !process.env.MATCHPLANE_EXCHANGE_RATE_URL?.trim();
  const url = await exchangeRateProviderUrl();
  url.searchParams.set("from", BASE_CURRENCY);
  url.searchParams.set("to", localCurrency);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new ExchangeRateProviderError(
          "汇率服务响应超时，请稍后重试",
          504,
        );
      }
      throw new ExchangeRateProviderError("汇率服务暂时不可用，请稍后重试");
    }

    if (!response.ok) {
      if (usesDefaultProvider && response.status === 404) {
        throw new ExchangeRateProviderError("汇率服务暂不支持该本地货币", 400);
      }
      throw new ExchangeRateProviderError("汇率服务暂时不可用，请稍后重试");
    }

    let payload: unknown;
    try {
      payload = await readJsonResponseBody<unknown>(
        response,
        PROVIDER_RESPONSE_LIMIT,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new ExchangeRateProviderError(
          "汇率服务响应超时，请稍后重试",
          504,
        );
      }
      throw new ExchangeRateProviderError("汇率服务返回了无效数据，请稍后重试");
    }

    const rate = extractRate(payload, localCurrency);
    if (rate === null) {
      throw new ExchangeRateProviderError("汇率服务返回了无效数据，请稍后重试");
    }
    return { rate, source: url.hostname };
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeRateProviderUrl(): Promise<URL> {
  const raw =
    process.env.MATCHPLANE_EXCHANGE_RATE_URL?.trim() || DEFAULT_PROVIDER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExchangeRateProviderError("汇率服务配置无效", 503);
  }

  // MatchPlane uses MATCHPLANE_ENVIRONMENT as the deployment profile. NODE_ENV is often
  // production for an optimized local Compose bundle and must not weaken this boundary.
  const production = isProductionEnvironment();
  const loopback = isLoopbackHostname(url.hostname);
  const developmentLoopback =
    !production && url.protocol === "http:" && loopback;
  if (
    url.username ||
    url.password ||
    url.hash ||
    isPrivateOrReservedIpLiteral(url.hostname) ||
    (loopback && !developmentLoopback) ||
    (url.protocol !== "https:" && !developmentLoopback)
  ) {
    throw new ExchangeRateProviderError("汇率服务配置无效", 503);
  }

  // Resolve immediately before fetch and fail closed if any answer is private, loopback,
  // link-local, metadata, multicast, documentation, or otherwise non-global. A local HTTP
  // loopback mock is the sole development exception, matching the project's endpoint contract.
  if (!developmentLoopback && !(await hasOnlyPublicAddresses(url.toString()))) {
    throw new ExchangeRateProviderError("汇率服务配置无效", 503);
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isExchangeRateConflict(error: unknown): boolean {
  if (error instanceof ExchangeRateConflictError) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "40P01";
}

function extractRate(payload: unknown, localCurrency: string): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.base === "string" &&
    record.base.toUpperCase() !== BASE_CURRENCY
  ) {
    return null;
  }

  const rates = record.rates;
  const rawRate =
    rates && typeof rates === "object" && !Array.isArray(rates)
      ? (rates as Record<string, unknown>)[localCurrency]
      : record.rate;
  const rate =
    typeof rawRate === "number"
      ? rawRate
      : typeof rawRate === "string"
        ? Number(rawRate)
        : Number.NaN;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1e12) return null;
  return rate;
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizeRateForStorage(rate: number): string {
  return rate.toFixed(12);
}

function exchangeRateVersion(row: StoredExchangeRate | null): number {
  if (!row) return 1;
  const version = Number(row.version);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function toPublicExchangeRate(row: StoredExchangeRate): ExchangeRateResult {
  const parsedRate =
    row.usdToLocalRate === null ? null : Number(row.usdToLocalRate);
  return {
    baseCurrency: BASE_CURRENCY,
    localCurrency: row.localCurrency || DEFAULT_LOCAL_CURRENCY,
    usdToLocalRate:
      parsedRate !== null && Number.isFinite(parsedRate) && parsedRate > 0
        ? parsedRate
        : null,
    rateSource: row.rateSource ?? null,
    rateUpdatedAt: normalizeTimestamp(row.rateUpdatedAt),
    version: exchangeRateVersion(row),
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function isMissingCurrencySettingsTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}
