-- Lease-backed, ordered conversion projection into store CRM and in-app notifications.

ALTER TABLE marketplace_conversion_outbox
    ADD COLUMN IF NOT EXISTS schema_version smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS aggregate_version bigint,
    ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS dead_at timestamptz,
    ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- Install the new checks without scanning 004-era rows. A single idempotent normalization update
-- then moves every 004-legal status to a 005-legal state before validation.
ALTER TABLE marketplace_conversion_outbox
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_status_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_schema_version_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_aggregate_version_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_aggregate_version_unique,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_claim_state_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_publication_state_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_dead_state_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_resolution_state_check,
    DROP CONSTRAINT IF EXISTS marketplace_conversion_outbox_attempt_audit_check;

ALTER TABLE marketplace_conversion_outbox
    ADD CONSTRAINT marketplace_conversion_outbox_status_check
        CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'dead', 'resolved'))
        NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_schema_version_check
        CHECK (schema_version > 0) NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_aggregate_version_check
        CHECK (aggregate_version > 0) NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_claim_state_check
        CHECK (
            (status = 'publishing'
             AND claimed_at IS NOT NULL
             AND claim_token IS NOT NULL
             AND claim_expires_at IS NOT NULL)
            OR
            (status <> 'publishing'
             AND claimed_at IS NULL
             AND claim_token IS NULL
             AND claim_expires_at IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_publication_state_check
        CHECK ((status = 'published') = (published_at IS NOT NULL)) NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_dead_state_check
        CHECK ((status = 'dead') = (dead_at IS NOT NULL)) NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_resolution_state_check
        CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)) NOT VALID,
    ADD CONSTRAINT marketplace_conversion_outbox_attempt_audit_check
        CHECK (
            (attempts = 0 AND last_attempt_at IS NULL)
            OR (attempts > 0 AND last_attempt_at IS NOT NULL)
        ) NOT VALID;

WITH ranked AS (
    SELECT id,
           status IN ('pending', 'failed') AND attempts >= 12 AS delivery_exhausted,
           row_number() OVER (
               PARTITION BY tenant_id, aggregate_type, aggregate_id
               ORDER BY created_at, id
           ) AS aggregate_version
    FROM marketplace_conversion_outbox
)
UPDATE marketplace_conversion_outbox AS outbox
SET aggregate_version = ranked.aggregate_version,
    status = CASE
        WHEN ranked.delivery_exhausted THEN 'dead'
        ELSE outbox.status
    END,
    attempts = CASE
        WHEN outbox.status = 'publishing' THEN GREATEST(outbox.attempts, 1)
        ELSE outbox.attempts
    END,
    claimed_at = CASE WHEN outbox.status = 'publishing' THEN outbox.claimed_at END,
    claim_token = CASE WHEN outbox.status = 'publishing' THEN outbox.claim_token END,
    claim_expires_at = CASE
        WHEN outbox.status = 'publishing'
            THEN COALESCE(outbox.claim_expires_at, outbox.claimed_at + INTERVAL '60 seconds')
    END,
    published_at = CASE
        WHEN outbox.status = 'published'
            THEN COALESCE(outbox.published_at, outbox.claimed_at, outbox.created_at)
    END,
    dead_at = CASE
        WHEN outbox.status = 'dead' OR ranked.delivery_exhausted
            THEN COALESCE(
                outbox.dead_at,
                outbox.last_attempt_at,
                outbox.claimed_at,
                outbox.published_at,
                outbox.created_at
            )
    END,
    resolved_at = CASE
        WHEN outbox.status = 'resolved'
            THEN COALESCE(outbox.resolved_at, outbox.created_at)
    END,
    last_attempt_at = CASE
        WHEN outbox.status = 'publishing'
            THEN COALESCE(outbox.last_attempt_at, outbox.claimed_at, outbox.created_at)
        WHEN outbox.attempts > 0
            THEN COALESCE(
                outbox.last_attempt_at,
                outbox.claimed_at,
                outbox.published_at,
                outbox.dead_at,
                outbox.created_at
            )
    END,
    last_error = CASE
        WHEN ranked.delivery_exhausted
            THEN 'migration dead-lettered 004 row at or above maximum delivery attempts'
        ELSE outbox.last_error
    END
FROM ranked
WHERE ranked.id = outbox.id;

ALTER TABLE marketplace_conversion_outbox
    VALIDATE CONSTRAINT marketplace_conversion_outbox_status_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_schema_version_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_aggregate_version_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_claim_state_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_publication_state_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_dead_state_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_resolution_state_check,
    VALIDATE CONSTRAINT marketplace_conversion_outbox_attempt_audit_check;

ALTER TABLE marketplace_conversion_outbox
    ALTER COLUMN aggregate_version SET NOT NULL,
    ADD CONSTRAINT marketplace_conversion_outbox_aggregate_version_unique
        UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version);

DROP INDEX IF EXISTS marketplace_conversion_outbox_claim_idx;
CREATE INDEX IF NOT EXISTS marketplace_conversion_outbox_ready_idx
    ON marketplace_conversion_outbox (available_at, created_at, id)
    WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS marketplace_conversion_outbox_expired_claim_idx
    ON marketplace_conversion_outbox (claim_expires_at, created_at, id)
    WHERE status = 'publishing';
CREATE INDEX IF NOT EXISTS marketplace_conversion_outbox_aggregate_order_idx
    ON marketplace_conversion_outbox
       (tenant_id, aggregate_type, aggregate_id, aggregate_version, created_at, id)
    WHERE status NOT IN ('published', 'resolved');
CREATE INDEX IF NOT EXISTS marketplace_conversion_outbox_dead_idx
    ON marketplace_conversion_outbox (dead_at, id)
    WHERE status = 'dead';

CREATE TABLE IF NOT EXISTS marketplace_store_customers (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    store_id uuid NOT NULL,
    demand_party_id uuid NOT NULL,
    first_seen_at timestamptz NOT NULL,
    last_activity_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id),
    FOREIGN KEY (tenant_id, demand_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, store_id, demand_party_id),
    UNIQUE (tenant_id, id),
    CHECK (last_activity_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS marketplace_store_customers_activity_idx
    ON marketplace_store_customers (tenant_id, store_id, last_activity_at DESC, id);

-- The 180002 handoff table predates the tenant-scoped foreign-key convention and only has a
-- globally unique `id` primary key. Add the composite key before opportunities reference it so
-- fresh installs and upgraded databases both preserve tenant isolation.
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sales_handoffs_tenant_id_id_idx
    ON marketplace_sales_handoffs (tenant_id, id);

CREATE TABLE IF NOT EXISTS marketplace_sales_opportunities (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    store_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    source_type text NOT NULL
        CHECK (source_type IN ('marketplace_introduction', 'marketplace_sales_handoff')),
    source_id uuid NOT NULL,
    introduction_id uuid,
    handoff_id uuid,
    source_status text NOT NULL CHECK (length(source_status) BETWEEN 1 AND 32),
    lead_stage text NOT NULL DEFAULT 'new'
        CHECK (lead_stage IN ('new', 'discovering', 'qualified', 'contact_requested',
                              'contact_exchanged', 'won', 'lost')),
    contact_consent_status text NOT NULL DEFAULT 'not_requested'
        CHECK (contact_consent_status IN ('not_requested', 'pending', 'accepted', 'declined')),
    favorite boolean NOT NULL DEFAULT false,
    staff_notes text NOT NULL DEFAULT '' CHECK (length(staff_notes) <= 2000),
    last_source_event_id uuid NOT NULL,
    last_source_occurred_at timestamptz NOT NULL,
    last_applied_version bigint NOT NULL CHECK (last_applied_version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES marketplace_store_customers(tenant_id, id),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, introduction_id) REFERENCES marketplace_introductions(tenant_id, id),
    FOREIGN KEY (tenant_id, handoff_id) REFERENCES marketplace_sales_handoffs(tenant_id, id),
    UNIQUE (tenant_id, source_type, source_id),
    UNIQUE (tenant_id, id),
    CHECK (
        (source_type = 'marketplace_introduction'
         AND introduction_id = source_id
         AND handoff_id IS NULL)
        OR
        (source_type = 'marketplace_sales_handoff'
         AND handoff_id = source_id
         AND introduction_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS marketplace_sales_opportunities_store_activity_idx
    ON marketplace_sales_opportunities (tenant_id, store_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS marketplace_sales_opportunities_customer_idx
    ON marketplace_sales_opportunities (tenant_id, customer_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS marketplace_sales_opportunity_offers (
    tenant_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, opportunity_id, offer_id),
    UNIQUE (tenant_id, opportunity_id, ordinal),
    FOREIGN KEY (tenant_id, opportunity_id)
        REFERENCES marketplace_sales_opportunities(tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, offer_id)
        REFERENCES marketplace_offers(tenant_id, id)
);

CREATE OR REPLACE FUNCTION enqueue_marketplace_contact_projection() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    next_aggregate_version bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            NEW.tenant_id::text || ':marketplace_introduction:' || NEW.introduction_id::text,
            0
        )
    );
    SELECT COALESCE(max(outbox.aggregate_version), 0) + 1
      INTO next_aggregate_version
      FROM marketplace_conversion_outbox AS outbox
     WHERE outbox.tenant_id = NEW.tenant_id
       AND outbox.aggregate_type = 'marketplace_introduction'
       AND outbox.aggregate_id = NEW.introduction_id;

    INSERT INTO marketplace_conversion_outbox
        (id, tenant_id, schema_version, source_type, source_id, aggregate_type,
         aggregate_id, aggregate_version, event_type)
    VALUES
        (pg_catalog.gen_random_uuid(), NEW.tenant_id, 1,
         'introduction_contact_event', NEW.id, 'marketplace_introduction',
         NEW.introduction_id, next_aggregate_version,
         'marketplace_' || NEW.event_type || '_' || NEW.decision);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_marketplace_handoff_projection() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO marketplace_conversion_outbox
        (id, tenant_id, schema_version, source_type, source_id, aggregate_type,
         aggregate_id, aggregate_version, event_type)
    VALUES
        (pg_catalog.gen_random_uuid(), NEW.tenant_id, 1,
         'sales_handoff', NEW.id, 'marketplace_sales_handoff', NEW.id, 1,
         'marketplace_sales_handoff_requested');
    RETURN NEW;
END;
$$;
