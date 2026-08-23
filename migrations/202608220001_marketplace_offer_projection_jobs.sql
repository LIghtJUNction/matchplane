-- Durable, monotonic delivery of canonical generic offers into child-owned catalogs.
--
-- The root offer row remains authoritative.  Jobs contain only scoped identity, version and
-- delivery state; workers must re-read the current canonical payload and active store binding
-- before every attempt.  Hosted stores are intentionally absent because PostgreSQL is already
-- their public catalog.

ALTER TABLE marketplace_offers
    ADD CONSTRAINT marketplace_offers_projection_scope_uidx
        UNIQUE (tenant_id, domain_id, store_id, id);

CREATE TABLE marketplace_offer_projection_jobs (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    store_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    canonical_version bigint NOT NULL CHECK (canonical_version > 0),
    request_id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'acked', 'superseded', 'dead')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
    lease_expires_at timestamptz,
    last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
    last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    acked_at timestamptz,
    FOREIGN KEY (tenant_id, domain_id, store_id)
        REFERENCES stores(tenant_id, domain_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, domain_id, store_id, offer_id)
        REFERENCES marketplace_offers(tenant_id, domain_id, store_id, id) ON DELETE CASCADE,
    UNIQUE (tenant_id, offer_id, canonical_version),
    UNIQUE (request_id),
    CHECK (
      (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK ((status = 'acked' AND acked_at IS NOT NULL) OR (status <> 'acked' AND acked_at IS NULL))
);

CREATE INDEX marketplace_offer_projection_jobs_ready_idx
    ON marketplace_offer_projection_jobs (next_attempt_at, created_at)
    WHERE status IN ('pending', 'retry', 'processing');

CREATE INDEX marketplace_offer_projection_jobs_offer_idx
    ON marketplace_offer_projection_jobs (tenant_id, offer_id, canonical_version DESC);

-- Converge any catalog copies created before the durable relay existed.  An inactive canonical
-- state is still projected: child adapters use it as a tombstone and exclude it from retrieval.
INSERT INTO marketplace_offer_projection_jobs (
    tenant_id,
    domain_id,
    store_id,
    offer_id,
    canonical_version
)
SELECT offer.tenant_id,
       offer.domain_id,
       offer.store_id,
       offer.id,
       offer.version
  FROM marketplace_offers offer
  JOIN stores store
    ON store.tenant_id = offer.tenant_id
   AND store.domain_id = offer.domain_id
   AND store.id = offer.store_id
 WHERE store.integration_kind <> 'hosted'
ON CONFLICT (tenant_id, offer_id, canonical_version) DO NOTHING;
