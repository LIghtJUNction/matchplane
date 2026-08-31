import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";

import { authDatabase } from "./auth";

const TOKEN_BYTES = 16;
// Unpadded base64url encodes sixteen bytes in exactly twenty-two characters.
const TOKEN_LENGTH = 22;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const ACQUISITION_SUBJECT_COOKIE = "matchplane_acquisition_subject";
export const ACQUISITION_SUBJECT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT = 10_000;

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

interface TransactionClient extends Queryable {
  release(): void;
}

interface TransactionDatabase {
  connect(): Promise<TransactionClient>;
}

export type AcquisitionLandingRecordResult =
  | "recorded"
  | "duplicate"
  | "daily_capacity_reached";

/** A token-free boundary error for expected acquisition storage failures. */
export class AcquisitionStorageError extends Error {
  constructor(cause: unknown) {
    super("acquisition storage operation failed", { cause });
    this.name = "AcquisitionStorageError";
  }
}

export interface ResolvedAcquisitionLink {
  id: string;
  tenantId: string;
  domainId: string;
  storeId: string;
  offerId: string;
  channelKey: string;
  sourceRef: string | null;
  campaignRef: string | null;
}

export interface AnonymousAcquisitionSubject {
  value: string;
  digest: Buffer;
  shouldSetCookie: boolean;
}

/** Generate a canonical, unpadded base64url token with exactly 128 bits of entropy. */
export function generateAcquisitionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Reject non-canonical encodings so one digest always corresponds to one public path token. */
export function isCanonicalAcquisitionToken(
  value: string | null | undefined,
): value is string {
  if (
    typeof value !== "string" ||
    value.length !== TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.length === TOKEN_BYTES && decoded.toString("base64url") === value
  );
}

export function digestAcquisitionToken(value: string): Buffer {
  if (!isCanonicalAcquisitionToken(value)) {
    throw new TypeError("acquisition token must be canonical 128-bit base64url");
  }
  return createHash("sha256").update(value, "ascii").digest();
}

/**
 * Reuse one valid first-party anonymous subject cookie or mint a new 128-bit value.
 * Only its SHA-256 digest is returned for persistence; no request header is inspected except Cookie.
 */
export function anonymousAcquisitionSubject(
  request: Request,
): AnonymousAcquisitionSubject {
  const existing = readUniqueCookie(
    request.headers.get("cookie"),
    ACQUISITION_SUBJECT_COOKIE,
  );
  const value = isCanonicalAcquisitionToken(existing)
    ? existing
    : generateAcquisitionToken();
  return {
    value,
    digest: digestAcquisitionToken(value),
    shouldSetCookie: value !== existing,
  };
}

/** Resolve only a currently public, sellable canonical offer target. */
export async function resolveActiveAcquisitionLink(
  rawToken: string,
  queryable: Queryable = authDatabase,
): Promise<ResolvedAcquisitionLink | null> {
  if (!isCanonicalAcquisitionToken(rawToken)) return null;
  const result = await acquisitionStorageQuery<ResolvedAcquisitionLink>(
    queryable,
    `SELECT link.id::text,
            link.tenant_id::text AS "tenantId",
            link.domain_id::text AS "domainId",
            link.store_id::text AS "storeId",
            link.offer_id::text AS "offerId",
            link.channel_key AS "channelKey",
            link.source_ref AS "sourceRef",
            link.campaign_ref AS "campaignRef"
       FROM marketplace_acquisition_links link
       JOIN tenants tenant
         ON tenant.id = link.tenant_id
        AND tenant.status = 'active'
       JOIN marketplace_offers offer
         ON offer.tenant_id = link.tenant_id
        AND offer.domain_id = link.domain_id
        AND offer.store_id = link.store_id
        AND offer.id = link.offer_id
        AND offer.status = 'active'
        AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
       JOIN stores store
         ON store.tenant_id = link.tenant_id
        AND store.domain_id = link.domain_id
        AND store.id = link.store_id
        AND store.status = 'active'
        AND store.visibility = 'public'
       JOIN domains domain
         ON domain.tenant_id = link.tenant_id
        AND domain.id = link.domain_id
        AND domain.status = 'active'
      WHERE link.token_digest = $1::bytea
        AND link.status = 'active'
        AND (link.expires_at IS NULL OR link.expires_at > clock_timestamp())
      LIMIT 1`,
    [digestAcquisitionToken(rawToken)],
  );
  return result.rows[0] ?? null;
}

/**
 * Record the only phase-one event under a per-link UTC-day capacity lock.
 * The separate post-lock statement is intentional: under READ COMMITTED it observes a writer that
 * committed before releasing the same transaction-scoped advisory lock.
 */
export async function recordAcquisitionLanding(
  link: Pick<ResolvedAcquisitionLink, "id" | "tenantId">,
  anonymousSubjectDigest: Buffer,
  database: TransactionDatabase = authDatabase,
): Promise<AcquisitionLandingRecordResult> {
  if (anonymousSubjectDigest.length !== 32) {
    throw new TypeError("anonymous subject digest must be SHA-256");
  }

  const client = await acquisitionStorageConnect(database);
  let transactionOpen = false;
  try {
    await acquisitionStorageQuery(
      client,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
    );
    transactionOpen = true;

    const clockResult = await acquisitionStorageQuery<{
      occurredAt: Date;
      occurredOn: string;
    }>(
      client,
      `SELECT event_clock.occurred_at AS "occurredAt",
              pg_catalog.timezone('UTC', event_clock.occurred_at)::date::text
                AS "occurredOn"
         FROM (VALUES (pg_catalog.clock_timestamp())) event_clock(occurred_at)`,
    );
    const eventClock = clockResult.rows[0];
    if (!eventClock || !UTC_DAY_PATTERN.test(eventClock.occurredOn)) {
      throw new TypeError("acquisition storage returned an invalid UTC event day");
    }

    await acquisitionStorageQuery(
      client,
      `SELECT pg_catalog.pg_advisory_xact_lock(
                pg_catalog.hashtextextended(
                  $1::text,
                  ($2::date - DATE '2000-01-01')::bigint
                )
              )`,
      [link.id, eventClock.occurredOn],
    );

    const insertResult = await acquisitionStorageQuery<{ inserted: boolean }>(
      client,
      `WITH inserted AS (
         INSERT INTO marketplace_acquisition_touchpoints
           (id, tenant_id, link_id, anonymous_subject_digest, event_type,
            occurred_at, occurred_on)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::bytea,
                'landing_viewed', $5::timestamptz, $6::date
          WHERE (
            SELECT COUNT(*)
              FROM marketplace_acquisition_touchpoints existing
             WHERE existing.tenant_id = $2::uuid
               AND existing.link_id = $3::uuid
               AND existing.occurred_on = $6::date
          ) < $7::bigint
         ON CONFLICT (tenant_id, link_id, anonymous_subject_digest, event_type)
         DO NOTHING
         RETURNING 1
       )
       SELECT EXISTS (SELECT 1 FROM inserted) AS inserted`,
      [
        randomUUID(),
        link.tenantId,
        link.id,
        anonymousSubjectDigest,
        eventClock.occurredAt,
        eventClock.occurredOn,
        ACQUISITION_TOUCHPOINTS_PER_LINK_UTC_DAY_LIMIT,
      ],
    );
    const inserted = insertResult.rows[0]?.inserted;
    if (typeof inserted !== "boolean") {
      throw new TypeError("acquisition storage returned an invalid insert result");
    }

    let outcome: AcquisitionLandingRecordResult = "recorded";
    if (!inserted) {
      const duplicateResult = await acquisitionStorageQuery<{
        duplicate: boolean;
      }>(
        client,
        `SELECT EXISTS (
           SELECT 1
             FROM marketplace_acquisition_touchpoints existing
            WHERE existing.tenant_id = $1::uuid
              AND existing.link_id = $2::uuid
              AND existing.anonymous_subject_digest = $3::bytea
              AND existing.event_type = 'landing_viewed'
         ) AS duplicate`,
        [link.tenantId, link.id, anonymousSubjectDigest],
      );
      const duplicate = duplicateResult.rows[0]?.duplicate;
      if (typeof duplicate !== "boolean") {
        throw new TypeError(
          "acquisition storage returned an invalid idempotency result",
        );
      }
      outcome = duplicate ? "duplicate" : "daily_capacity_reached";
    }

    await acquisitionStorageQuery(client, "COMMIT");
    transactionOpen = false;
    return outcome;
  } catch (cause) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw cause;
  } finally {
    client.release();
  }
}

async function acquisitionStorageConnect(
  database: TransactionDatabase,
): Promise<TransactionClient> {
  try {
    return await database.connect();
  } catch (cause) {
    throw new AcquisitionStorageError(cause);
  }
}

async function acquisitionStorageQuery<
  Row extends QueryResultRow = QueryResultRow,
>(
  queryable: Queryable,
  sql: string,
  values?: unknown[],
): Promise<QueryResult<Row>> {
  try {
    return await queryable.query<Row>(sql, values);
  } catch (cause) {
    throw new AcquisitionStorageError(cause);
  }
}

function readUniqueCookie(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  let match: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const candidate = part.trim();
    if (!candidate.startsWith(prefix)) continue;
    if (match !== null) return null;
    match = candidate.slice(prefix.length);
  }
  return match;
}
