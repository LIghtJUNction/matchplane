import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { authDatabase } from "./lib/auth";
import {
  buildCatalogProjectionArguments,
  parseCatalogProjectionAck,
  type CatalogOfferStatus,
} from "./catalog-projection";
import { readActiveDirectChildRoutes } from "./platform-child-routes";
import {
  invokeSubplatformMcpTool,
  resolveSubplatformMcpEndpoint,
} from "./platform-agent-tool";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_LEASE_SECONDS = 45;
const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;
const CATALOG_TOOL = "catalog.upsert";

type JobStatus =
  | "pending"
  | "processing"
  | "retry"
  | "acked"
  | "superseded"
  | "dead";

interface ProjectionJob {
  id: string;
  tenantId: string;
  domainId: string;
  storeId: string;
  offerId: string;
  canonicalVersion: number;
  requestId: string;
  attempts: number;
  registrationId: string | null;
  platformPath: string | null;
  mcpServerKey: string | null;
}

interface CanonicalProjectionSnapshot {
  tenantId: string;
  domainId: string;
  storeId: string;
  offerId: string;
  canonicalVersion: number;
  externalKey: string;
  displayName: string;
  productTemplateId: string | null;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
  status: CatalogOfferStatus;
  registrationId: string | null;
  platformPath: string | null;
  mcpServerKey: string | null;
  storeStatus: string;
  integrationKind: string;
}

interface RelayOptions {
  workerId: string;
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
}

interface RelayState {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
}

const relayGlobal = globalThis as typeof globalThis & {
  __matchplaneCatalogProjectionRelay?: RelayState;
};

/** Start one non-blocking relay loop per Node.js process. PostgreSQL leases make replicas safe. */
export function startCatalogProjectionRelay(): void {
  if (process.env.MATCHPLANE_CATALOG_RELAY_ENABLED === "false") return;
  const state = relayGlobal.__matchplaneCatalogProjectionRelay ?? {
    started: false,
    running: false,
    timer: null,
  };
  relayGlobal.__matchplaneCatalogProjectionRelay = state;
  if (state.started) return;
  state.started = true;
  const options: RelayOptions = {
    workerId: boundedWorkerId(`${hostname()}:${process.pid}:${randomUUID()}`),
    batchSize: boundedInteger(
      process.env.MATCHPLANE_CATALOG_RELAY_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      1,
      32,
    ),
    leaseSeconds: boundedInteger(
      process.env.MATCHPLANE_CATALOG_RELAY_LEASE_SECONDS,
      DEFAULT_LEASE_SECONDS,
      15,
      300,
    ),
    maxAttempts: boundedInteger(
      process.env.MATCHPLANE_CATALOG_RELAY_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      1,
      DEFAULT_MAX_ATTEMPTS,
    ),
  };
  const interval = boundedInteger(
    process.env.MATCHPLANE_CATALOG_RELAY_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    1_000,
    60_000,
  );
  const schedule = (delay: number) => {
    state.timer = setTimeout(async () => {
      if (state.running) return schedule(interval);
      state.running = true;
      try {
        await runCatalogProjectionRelayOnce(options);
      } catch {
        process.stderr.write("[catalog-relay] iteration failed\n");
      } finally {
        state.running = false;
        schedule(interval);
      }
    }, delay);
    state.timer.unref();
  };
  schedule(1_000);
}

/** Claim and process one bounded batch; exported for operational probes and deterministic tests. */
export async function runCatalogProjectionRelayOnce(
  options: RelayOptions = {
    workerId: boundedWorkerId(`${hostname()}:${process.pid}:${randomUUID()}`),
    batchSize: DEFAULT_BATCH_SIZE,
    leaseSeconds: DEFAULT_LEASE_SECONDS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  },
): Promise<{
  claimed: number;
  acked: number;
  superseded: number;
  retried: number;
  dead: number;
}> {
  await closeExhaustedJobs(options.maxAttempts);
  const jobs = await claimProjectionJobs(options);
  const summary = {
    claimed: jobs.length,
    acked: 0,
    superseded: 0,
    retried: 0,
    dead: 0,
  };
  for (const job of jobs) {
    const outcome = await deliverProjectionJob(job, options);
    summary[outcome] += 1;
  }
  return summary;
}

async function claimProjectionJobs(
  options: RelayOptions,
): Promise<ProjectionJob[]> {
  const result = await authDatabase.query(
    `WITH candidates AS (
       SELECT job.id
         FROM marketplace_offer_projection_jobs job
        WHERE job.attempts < $3
          AND (
            (job.status IN ('pending', 'retry') AND job.next_attempt_at <= clock_timestamp())
            OR (
              job.status = 'processing'
              AND job.lease_expires_at <= clock_timestamp()
            )
          )
        ORDER BY job.next_attempt_at ASC, job.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     )
     UPDATE marketplace_offer_projection_jobs job
        SET status = 'processing',
            attempts = job.attempts + 1,
            lease_owner = $1,
            lease_expires_at = clock_timestamp() + ($4::integer * interval '1 second'),
            last_error_code = NULL,
            last_error = NULL,
            updated_at = clock_timestamp()
       FROM candidates
      WHERE job.id = candidates.id
     RETURNING job.id::text,
               job.tenant_id::text,
               job.domain_id::text,
               job.store_id::text,
               job.offer_id::text,
               job.canonical_version::text,
               job.request_id::text,
               job.attempts,
               job.registration_id::text,
               job.platform_path,
               job.mcp_server_key`,
    [
      options.workerId,
      options.batchSize,
      options.maxAttempts,
      options.leaseSeconds,
    ],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    domainId: String(row.domain_id),
    storeId: String(row.store_id),
    offerId: String(row.offer_id),
    canonicalVersion: safeDatabaseVersion(row.canonical_version),
    requestId: String(row.request_id),
    attempts: Number(row.attempts),
    registrationId: optionalString(row.registration_id),
    platformPath: optionalString(row.platform_path),
    mcpServerKey: optionalString(row.mcp_server_key),
  }));
}

async function deliverProjectionJob(
  job: ProjectionJob,
  options: RelayOptions,
): Promise<"acked" | "superseded" | "retried" | "dead"> {
  try {
    const snapshot = await readCanonicalProjectionSnapshot(job);
    if (!snapshot)
      throw new PermanentProjectionError(
        "canonical_offer_missing",
        "canonical offer is missing",
      );
    if (!currentDestination(snapshot)) {
      throw new RetryableProjectionError(
        "destination_unavailable",
        "canonical offer has no active immutable projection destination",
      );
    }
    if (
      snapshot.canonicalVersion > job.canonicalVersion ||
      snapshot.registrationId !== job.registrationId ||
      snapshot.platformPath !== job.platformPath ||
      snapshot.mcpServerKey !== job.mcpServerKey
    ) {
      await ensureLatestProjectionJob(snapshot);
      await finishJob(job, options.workerId, "superseded");
      return "superseded";
    }
    if (snapshot.canonicalVersion < job.canonicalVersion) {
      throw new PermanentProjectionError(
        "canonical_version_regressed",
        "canonical offer version is lower than the durable job version",
      );
    }
    if (snapshot.integrationKind === "hosted") {
      await finishJob(job, options.workerId, "superseded");
      return "superseded";
    }
    if (snapshot.storeStatus !== "active") {
      throw new RetryableProjectionError(
        "store_inactive",
        "connected store is not active",
      );
    }
    await resolveProjectionRoute(snapshot);
    const endpoint = await resolveSubplatformMcpEndpoint(snapshot.mcpServerKey);
    if (!endpoint) {
      throw new RetryableProjectionError(
        "endpoint_unavailable",
        "child MCP endpoint is unavailable",
      );
    }
    const projection = buildCatalogProjectionArguments({
      requestId: job.requestId,
      tenantId: snapshot.tenantId,
      domainId: snapshot.domainId,
      platformPath: snapshot.platformPath,
      offer: {
        offerId: snapshot.offerId,
        externalKey: snapshot.externalKey,
        displayName: snapshot.displayName,
        productTemplateId: snapshot.productTemplateId,
        attributes: snapshot.attributes,
        terms: snapshot.terms,
        status: snapshot.status,
        canonicalVersion: snapshot.canonicalVersion,
      },
    });
    const execution = await invokeSubplatformMcpTool({
      endpoint,
      toolName: CATALOG_TOOL,
      arguments: projection,
      requestId: job.requestId,
      platformPath: snapshot.platformPath,
      actorSubject: "system:catalog-projection-relay",
    });
    if (!execution.ok) {
      if (execution.status === 429 || execution.status >= 500) {
        throw new RetryableProjectionError(
          `child_http_${execution.status}`,
          `child catalog call failed with HTTP ${execution.status}`,
        );
      }
      throw new PermanentProjectionError(
        `child_http_${execution.status}`,
        `child catalog call was rejected with HTTP ${execution.status}`,
      );
    }
    const acknowledgement = parseCatalogProjectionAck(
      execution.payload,
      projection,
    );
    if (!acknowledgement.ok) {
      throw new PermanentProjectionError("invalid_ack", acknowledgement.error);
    }
    const status: JobStatus = acknowledgement.superseded
      ? "superseded"
      : "acked";
    await finishJob(job, options.workerId, status);
    return status;
  } catch (error) {
    const problem = projectionProblem(error);
    if (problem.retryable && job.attempts < options.maxAttempts) {
      await retryJob(job, options.workerId, problem);
      return "retried";
    }
    await deadLetterJob(job, options.workerId, problem);
    return "dead";
  }
}

async function readCanonicalProjectionSnapshot(
  job: ProjectionJob,
): Promise<CanonicalProjectionSnapshot | null> {
  const result = await authDatabase.query(
    `SELECT offer.tenant_id::text AS tenant_id,
            offer.domain_id::text AS domain_id,
            offer.store_id::text AS store_id,
            offer.id::text AS offer_id,
            offer.version::text AS canonical_version,
            offer.external_key,
            offer.display_name,
            offer.product_template_id,
            offer.attributes,
            offer.terms,
            offer.status AS offer_status,
            registration.id::text AS registration_id,
            alias.path AS platform_path,
            COALESCE(
              NULLIF(registration.manifest -> 'agent' ->> 'mcpServerKey', ''),
              registration.slug
            ) AS mcp_server_key,
            store.status AS store_status,
            store.integration_kind
       FROM marketplace_offers offer
       JOIN stores store
         ON store.tenant_id = offer.tenant_id
        AND store.domain_id = offer.domain_id
        AND store.id = offer.store_id
       LEFT JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical
       LEFT JOIN subplatform_registrations registration
         ON registration.id = store.current_registration_id
        AND registration.tenant_id = store.tenant_id
        AND registration.domain_id = store.domain_id
        AND registration.state = 'active'
      WHERE offer.tenant_id = $1::uuid
        AND offer.domain_id = $2::uuid
        AND offer.store_id = $3::uuid
        AND offer.id = $4::uuid
      LIMIT 1`,
    [job.tenantId, job.domainId, job.storeId, job.offerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId: String(row.tenant_id),
    domainId: String(row.domain_id),
    storeId: String(row.store_id),
    offerId: String(row.offer_id),
    canonicalVersion: safeDatabaseVersion(row.canonical_version),
    externalKey: String(row.external_key),
    displayName: String(row.display_name),
    productTemplateId: optionalString(row.product_template_id),
    attributes: objectValue(row.attributes),
    terms: objectValue(row.terms),
    status: offerStatus(row.offer_status),
    registrationId: optionalString(row.registration_id),
    platformPath: optionalString(row.platform_path),
    mcpServerKey: optionalString(row.mcp_server_key),
    storeStatus: String(row.store_status),
    integrationKind: String(row.integration_kind),
  };
}

async function resolveProjectionRoute(snapshot: CanonicalProjectionSnapshot) {
  const routes = await readActiveDirectChildRoutes("/", snapshot.tenantId, {
    isRootAdministrator: true,
  });
  const route = routes.find(
    (candidate) =>
      candidate.path === snapshot.platformPath &&
      candidate.tenantId === snapshot.tenantId &&
      candidate.domainId === snapshot.domainId &&
      candidate.mcpServerKey === snapshot.mcpServerKey,
  );
  if (!route)
    throw new RetryableProjectionError(
      "route_unavailable",
      "active child route is unavailable",
    );
  if (!route.agentMcpTools.includes(CATALOG_TOOL)) {
    throw new RetryableProjectionError(
      "tool_unavailable",
      "child does not declare catalog.upsert",
    );
  }
  return route;
}

async function ensureLatestProjectionJob(
  snapshot: CanonicalProjectionSnapshot,
): Promise<void> {
  await authDatabase.query(
    `INSERT INTO marketplace_offer_projection_jobs (
       tenant_id,
       domain_id,
       store_id,
       offer_id,
       canonical_version,
       registration_id,
       platform_path,
       mcp_server_key
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::uuid, $7, $8
     )
     ON CONFLICT (tenant_id, offer_id, canonical_version, registration_id) DO NOTHING`,
    [
      snapshot.tenantId,
      snapshot.domainId,
      snapshot.storeId,
      snapshot.offerId,
      snapshot.canonicalVersion,
      snapshot.registrationId,
      snapshot.platformPath,
      snapshot.mcpServerKey,
    ],
  );
}

async function finishJob(
  job: ProjectionJob,
  workerId: string,
  status: "acked" | "superseded",
): Promise<void> {
  await authDatabase.query(
    `UPDATE marketplace_offer_projection_jobs
        SET status = $3,
            lease_owner = NULL,
            lease_expires_at = NULL,
            acked_at = CASE WHEN $3 = 'acked' THEN clock_timestamp() ELSE NULL END,
            last_error_code = NULL,
            last_error = NULL,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND status = 'processing'
        AND lease_owner = $2`,
    [job.id, workerId, status],
  );
}

async function retryJob(
  job: ProjectionJob,
  workerId: string,
  problem: ProjectionProblem,
): Promise<void> {
  await authDatabase.query(
    `UPDATE marketplace_offer_projection_jobs
        SET status = 'retry',
            next_attempt_at = clock_timestamp() + ($3::integer * interval '1 second'),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = $4,
            last_error = $5,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND status = 'processing'
        AND lease_owner = $2`,
    [job.id, workerId, retryDelaySeconds(job), problem.code, problem.message],
  );
}

async function deadLetterJob(
  job: ProjectionJob,
  workerId: string,
  problem: ProjectionProblem,
): Promise<void> {
  await authDatabase.query(
    `UPDATE marketplace_offer_projection_jobs
        SET status = 'dead',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = $3,
            last_error = $4,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid
        AND status = 'processing'
        AND lease_owner = $2`,
    [job.id, workerId, problem.code, problem.message],
  );
}

async function closeExhaustedJobs(maxAttempts: number): Promise<void> {
  await authDatabase.query(
    `UPDATE marketplace_offer_projection_jobs
        SET status = 'dead',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = COALESCE(last_error_code, 'retry_exhausted'),
            last_error = COALESCE(last_error, 'catalog projection retry budget exhausted'),
            updated_at = clock_timestamp()
      WHERE attempts >= $1
        AND (
          status IN ('pending', 'retry')
          OR (status = 'processing' AND lease_expires_at <= clock_timestamp())
        )`,
    [maxAttempts],
  );
}

function retryDelaySeconds(job: ProjectionJob): number {
  const exponential = Math.min(
    5 * 2 ** Math.max(0, job.attempts - 1),
    MAX_RETRY_DELAY_SECONDS,
  );
  const jitter =
    0.8 + (Number.parseInt(job.requestId.slice(-2), 16) / 255) * 0.4;
  return Math.max(1, Math.round(exponential * jitter));
}

function safeDatabaseVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new PermanentProjectionError(
      "unsafe_canonical_version",
      "canonical version exceeds the relay's safe integer range",
    );
  }
  return version;
}

function offerStatus(value: unknown): CatalogOfferStatus {
  if (
    value === "draft" ||
    value === "active" ||
    value === "reserved" ||
    value === "sold" ||
    value === "withdrawn" ||
    value === "expired"
  ) {
    return value;
  }
  throw new PermanentProjectionError(
    "invalid_offer_status",
    "canonical offer status is invalid",
  );
}

function currentDestination(
  snapshot: CanonicalProjectionSnapshot,
): snapshot is CanonicalProjectionSnapshot & {
  registrationId: string;
  platformPath: string;
  mcpServerKey: string;
} {
  return Boolean(
    snapshot.registrationId && snapshot.platformPath && snapshot.mcpServerKey,
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function boundedWorkerId(value: string): string {
  return value.slice(0, 200);
}

interface ProjectionProblem {
  code: string;
  message: string;
  retryable: boolean;
}

class RetryableProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class PermanentProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function projectionProblem(error: unknown): ProjectionProblem {
  if (error instanceof RetryableProjectionError) {
    return {
      code: boundedError(error.code, 80),
      message: boundedError(error.message, 1000),
      retryable: true,
    };
  }
  if (error instanceof PermanentProjectionError) {
    return {
      code: boundedError(error.code, 80),
      message: boundedError(error.message, 1000),
      retryable: false,
    };
  }
  return {
    code: "relay_error",
    message:
      "catalog projection relay failed without exposing provider details",
    retryable: true,
  };
}

function boundedError(value: string, maximum: number): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (sanitized || "catalog projection failed").slice(0, maximum);
}
