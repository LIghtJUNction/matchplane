import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";

import { authDatabase } from "./auth";

const TOKEN_BYTES = 16;
// Unpadded base64url encodes sixteen bytes in exactly twenty-two characters.
const TOKEN_LENGTH = 22;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const ACQUISITION_SUBJECT_COOKIE = "matchplane_acquisition_subject";
export const ACQUISITION_SUBJECT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
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
  const result = await queryable.query<ResolvedAcquisitionLink>(
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

/** Record the only phase-one event with a database-enforced idempotency key. */
export async function recordAcquisitionLanding(
  link: Pick<ResolvedAcquisitionLink, "id" | "tenantId">,
  anonymousSubjectDigest: Buffer,
  queryable: Queryable = authDatabase,
): Promise<void> {
  if (anonymousSubjectDigest.length !== 32) {
    throw new TypeError("anonymous subject digest must be SHA-256");
  }
  await queryable.query(
    `INSERT INTO marketplace_acquisition_touchpoints
       (id, tenant_id, link_id, anonymous_subject_digest, event_type, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bytea,
             'landing_viewed', clock_timestamp())
     ON CONFLICT (tenant_id, link_id, anonymous_subject_digest, event_type)
     DO NOTHING`,
    [randomUUID(), link.tenantId, link.id, anonymousSubjectDigest],
  );
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
