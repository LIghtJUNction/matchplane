import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
  ResponseBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { jsonError } from "../../../../src/lib/json-error";
import {
  fetchPinnedPublicText,
  PinnedPublicEndpointError,
  PinnedPublicRedirectError,
} from "../../../../src/lib/pinned-public-endpoint";
import { isPrivateOrReservedIpLiteral } from "../../../../src/lib/public-endpoint";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
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
  rateProvider: string | null;
  rateEffectiveDate: unknown;
  rateResponseDigest: string | null;
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
  usdToLocalRateExact: string | null;
  rateSource: string | null;
  rateProvider: string | null;
  rateEffectiveDate: string | null;
  rateResponseDigest: string | null;
  rateUpdatedAt: string | null;
  version: number;
}

interface EditorContext {
  actorId: string;
}

interface ProviderRateSnapshot {
  rateExact: string;
  source: string;
  provider: string;
  effectiveDate: string;
  responseDigest: string;
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
              currency.rate_provider AS "rateProvider",
              currency.rate_effective_date AS "rateEffectiveDate",
              currency.rate_response_digest AS "rateResponseDigest",
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

    return Response.json(
      { exchangeRate: toPublicExchangeRate(row) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (isCurrencySettingsSchemaUnavailable(error)) {
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
      return Response.json(
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
      rateProvider: null,
      rateEffectiveDate: null,
      rateResponseDigest: null,
      actorId: editor.actorId,
    });
    await transactionClient.query("COMMIT");
    return Response.json(
      { exchangeRate: toPublicExchangeRate(updated) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (isExchangeRateConflict(error)) {
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }
    if (isCurrencySettingsSchemaUnavailable(error)) {
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

  let latest: ProviderRateSnapshot;
  try {
    latest = await fetchLatestUsdRate(input.localCurrency, request.signal);
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
    throwIfRequestAborted(request.signal);
    const transactionClient = await authDatabase.connect();
    client = transactionClient;
    throwIfRequestAborted(request.signal);
    await transactionClient.query("BEGIN");
    throwIfRequestAborted(request.signal);

    const tenantActive = await lockActiveTenant(transactionClient, tenantId);
    throwIfRequestAborted(request.signal);
    if (!tenantActive) {
      await transactionClient.query("ROLLBACK");
      return jsonError("商城不存在", 404);
    }

    const current = await readStoredExchangeRate(transactionClient, tenantId);
    throwIfRequestAborted(request.signal);
    if (exchangeRateVersion(current) !== input.expectedVersion) {
      await transactionClient.query("ROLLBACK");
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }

    const updated = await writeStoredExchangeRate({
      client: transactionClient,
      tenantId,
      current,
      localCurrency: input.localCurrency,
      usdToLocalRate: latest.rateExact,
      rateSource: latest.source,
      rateProvider: latest.provider,
      rateEffectiveDate: latest.effectiveDate,
      rateResponseDigest: latest.responseDigest,
      actorId: editor.actorId,
      signal: request.signal,
    });
    throwIfRequestAborted(request.signal);
    await transactionClient.query("COMMIT");
    return Response.json(
      { exchangeRate: toPublicExchangeRate(updated) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (request.signal.aborted) {
      return jsonError("汇率同步已取消，请稍后重试", 504);
    }
    if (isExchangeRateConflict(error)) {
      return jsonError("货币设置已被其他人更新，请刷新后重试", 409);
    }
    if (isCurrencySettingsSchemaUnavailable(error)) {
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
            rate_provider AS "rateProvider",
            rate_effective_date AS "rateEffectiveDate",
            rate_response_digest AS "rateResponseDigest",
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
  rateProvider: string | null;
  rateEffectiveDate: string | null;
  rateResponseDigest: string | null;
  actorId: string;
  signal?: AbortSignal;
}): Promise<StoredExchangeRate> {
  const nextVersion = exchangeRateVersion(input.current) + 1;
  const parameters = [
    input.tenantId,
    input.localCurrency,
    input.usdToLocalRate,
    input.rateSource,
    input.rateProvider,
    input.rateEffectiveDate,
    input.rateResponseDigest,
  ];
  if (!input.current) {
    const inserted = await input.client.query<StoredExchangeRate>(
      `INSERT INTO mall_currency_settings
         (tenant_id, local_currency, usd_to_local_rate, rate_source,
          rate_provider, rate_effective_date, rate_response_digest,
          rate_updated_at, version, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::numeric, $4, $5, $6::date, $7,
               CASE WHEN $3::numeric IS NULL THEN NULL ELSE clock_timestamp() END,
               $8::bigint, clock_timestamp(), clock_timestamp())
       RETURNING local_currency AS "localCurrency",
                 usd_to_local_rate::text AS "usdToLocalRate",
                 rate_source AS "rateSource",
                 rate_provider AS "rateProvider",
                 rate_effective_date AS "rateEffectiveDate",
                 rate_response_digest AS "rateResponseDigest",
                 rate_updated_at AS "rateUpdatedAt",
                 version::text`,
      [...parameters, nextVersion],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("currency settings insert returned no row");
    throwIfRequestAborted(input.signal);
    await writeAuditEvent(input, null, row);
    return row;
  }

  const updated = await input.client.query<StoredExchangeRate>(
    `UPDATE mall_currency_settings
        SET local_currency = $2,
            usd_to_local_rate = $3::numeric,
            rate_source = $4,
            rate_provider = $5,
            rate_effective_date = $6::date,
            rate_response_digest = $7,
            rate_updated_at = CASE
              WHEN $3::numeric IS NULL THEN NULL
              ELSE clock_timestamp()
            END,
            version = version + 1,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND version = $8::bigint
      RETURNING local_currency AS "localCurrency",
                usd_to_local_rate::text AS "usdToLocalRate",
                rate_source AS "rateSource",
                rate_provider AS "rateProvider",
                rate_effective_date AS "rateEffectiveDate",
                rate_response_digest AS "rateResponseDigest",
                rate_updated_at AS "rateUpdatedAt",
                version::text`,
    [...parameters, input.current.version],
  );
  const row = updated.rows[0];
  if (!row) throw new ExchangeRateConflictError();
  throwIfRequestAborted(input.signal);
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
        previous_usd_to_local_rate_exact: previous?.usdToLocalRate ?? null,
        local_currency: next.localCurrency,
        usd_to_local_rate_exact: next.usdToLocalRate,
        rate_source: next.rateSource,
        rate_provider: next.rateProvider,
        rate_effective_date: normalizeDate(next.rateEffectiveDate),
        rate_response_digest: next.rateResponseDigest,
      }),
    ],
  );
}

async function fetchLatestUsdRate(
  localCurrency: string,
  signal?: AbortSignal,
): Promise<ProviderRateSnapshot> {
  if (localCurrency === BASE_CURRENCY) {
    const effectiveDate = new Date().toISOString().slice(0, 10);
    const identitySummary = JSON.stringify({
      base: BASE_CURRENCY,
      date: effectiveDate,
      provider: "identity",
      rate: "1",
    });
    return {
      rateExact: "1",
      source: "identity",
      provider: "identity",
      effectiveDate,
      responseDigest: responseDigest(identitySummary),
    };
  }

  const usesDefaultProvider = !process.env.MATCHPLANE_EXCHANGE_RATE_URL?.trim();
  const url = exchangeRateProviderUrl();
  url.searchParams.set("from", BASE_CURRENCY);
  url.searchParams.set("to", localCurrency);

  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchPinnedPublicText(url, {
      requestTimeoutMs: PROVIDER_TIMEOUT_MS,
      responseBodyTimeoutMs: PROVIDER_TIMEOUT_MS,
      responseLimitBytes: PROVIDER_RESPONSE_LIMIT,
      signal,
    }));
  } catch (error) {
    throw mapProviderTransportError(error);
  }

  if (!response.ok) {
    if (usesDefaultProvider && response.status === 404) {
      throw new ExchangeRateProviderError("汇率服务暂不支持该本地货币", 400);
    }
    throw new ExchangeRateProviderError("汇率服务暂时不可用，请稍后重试");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(quoteJsonNumbers(text));
  } catch {
    throw new ExchangeRateProviderError("汇率服务返回了无效数据，请稍后重试");
  }

  const snapshot = extractProviderRate(payload, localCurrency, url.hostname);
  if (!snapshot) {
    throw new ExchangeRateProviderError("汇率服务返回了无效数据，请稍后重试");
  }
  return {
    ...snapshot,
    source: url.hostname,
    responseDigest: responseDigest(text),
  };
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("exchange rate request aborted");
  error.name = "AbortError";
  throw error;
}

function mapProviderTransportError(error: unknown): ExchangeRateProviderError {
  if (
    error instanceof PinnedPublicEndpointError ||
    (error instanceof Error && error.name === "PinnedPublicEndpointError")
  ) {
    return new ExchangeRateProviderError("汇率服务配置无效", 503);
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new ExchangeRateProviderError("汇率服务响应超时，请稍后重试", 504);
  }
  if (error instanceof PinnedPublicRedirectError) {
    return new ExchangeRateProviderError("汇率服务暂时不可用，请稍后重试");
  }
  if (error instanceof ResponseBodyTooLargeError) {
    return new ExchangeRateProviderError("汇率服务返回了无效数据，请稍后重试");
  }
  return new ExchangeRateProviderError("汇率服务暂时不可用，请稍后重试");
}

function exchangeRateProviderUrl(): URL {
  const raw =
    process.env.MATCHPLANE_EXCHANGE_RATE_URL?.trim() || DEFAULT_PROVIDER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExchangeRateProviderError("汇率服务配置无效", 503);
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    isPrivateOrReservedIpLiteral(url.hostname)
  ) {
    throw new ExchangeRateProviderError("汇率服务配置无效", 503);
  }
  return url;
}

function isExchangeRateConflict(error: unknown): boolean {
  if (error instanceof ExchangeRateConflictError) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "40P01";
}

function extractProviderRate(
  payload: unknown,
  localCurrency: string,
  fallbackProvider: string,
): Omit<ProviderRateSnapshot, "source" | "responseDigest"> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.base !== "string" ||
    record.base.trim().toUpperCase() !== BASE_CURRENCY
  ) {
    return null;
  }

  const effectiveDate = normalizeProviderDate(
    record.date ?? record.effectiveDate ?? record.effective_date,
  );
  if (!effectiveDate) return null;
  const provider =
    record.provider === undefined
      ? fallbackProvider
      : normalizeProviderIdentifier(record.provider);
  if (!provider) return null;

  const rates = record.rates;
  const rawRate =
    rates && typeof rates === "object" && !Array.isArray(rates)
      ? (rates as Record<string, unknown>)[localCurrency]
      : record.rate;
  const rateExact = normalizeExactPositiveDecimal(rawRate);
  return rateExact ? { rateExact, provider, effectiveDate } : null;
}

/** Quote JSON number tokens before JSON.parse so provider decimals never pass through Number. */
function quoteJsonNumbers(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; ) {
    const character = value[index];
    if (inString) {
      result += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      index += 1;
      continue;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      const token = value
        .slice(index)
        .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
      if (token) {
        result += `"${token}"`;
        index += token.length;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

function normalizeExactPositiveDecimal(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(
    value,
  );
  if (!match) return null;
  const integer = match[1];
  const fraction = match[2] ?? "";
  const exponentText = match[3] ?? "0";
  if (!/^[+-]?\d{1,3}$/.test(exponentText)) return null;
  const exponent = Number(exponentText);
  if (Math.abs(exponent) > 100) return null;

  const expanded = expandDecimal(integer, fraction, exponent);
  const [rawWhole, rawFraction = ""] = expanded.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = rawFraction.replace(/0+$/, "");
  const normalized = normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
  if (!/[1-9]/.test(normalized)) return null;
  return exactRateExceedsLimit(whole, normalizedFraction) ? null : normalized;
}

function expandDecimal(
  integer: string,
  fraction: string,
  exponent: number,
): string {
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) {
    return `0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function exactRateExceedsLimit(whole: string, fraction: string): boolean {
  if (whole.length !== 13) return whole.length > 13;
  if (whole !== "1000000000000") return whole > "1000000000000";
  return fraction.length > 0;
}

function normalizeProviderDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function normalizeProviderIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  return identifier.length >= 1 &&
    identifier.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(identifier)
    ? identifier
    : null;
}

function responseDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
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
    usdToLocalRateExact: row.usdToLocalRate,
    rateSource: row.rateSource ?? null,
    rateProvider: row.rateProvider ?? null,
    rateEffectiveDate: normalizeDate(row.rateEffectiveDate),
    rateResponseDigest: row.rateResponseDigest ?? null,
    rateUpdatedAt: normalizeTimestamp(row.rateUpdatedAt),
    version: exchangeRateVersion(row),
  };
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function isCurrencySettingsSchemaUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}
