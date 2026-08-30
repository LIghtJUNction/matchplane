CREATE TABLE marketplace_conversion_outbox (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    source_type text NOT NULL CHECK (
        source_type IN ('introduction_contact_event', 'sales_handoff')
    ),
    source_id uuid NOT NULL,
    aggregate_type text NOT NULL CHECK (
        aggregate_type IN ('marketplace_introduction', 'marketplace_sales_handoff')
    ),
    aggregate_id uuid NOT NULL,
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 96),
    status text NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'publishing', 'published', 'failed', 'dead')
    ),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claim_token uuid,
    claimed_at timestamptz,
    last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at timestamptz,
    UNIQUE (source_type, source_id),
    CHECK (
        (status = 'publishing' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
        OR (status <> 'publishing' AND claim_token IS NULL AND claimed_at IS NULL)
    )
);

CREATE INDEX marketplace_conversion_outbox_claim_idx
ON marketplace_conversion_outbox (available_at, created_at, id)
WHERE status IN ('pending', 'failed');

CREATE INDEX marketplace_conversion_outbox_aggregate_idx
ON marketplace_conversion_outbox (tenant_id, aggregate_type, aggregate_id, created_at);

CREATE FUNCTION enqueue_marketplace_contact_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO marketplace_conversion_outbox (
        id,
        tenant_id,
        source_type,
        source_id,
        aggregate_type,
        aggregate_id,
        event_type
    ) VALUES (
        pg_catalog.gen_random_uuid(),
        NEW.tenant_id,
        'introduction_contact_event',
        NEW.id,
        'marketplace_introduction',
        NEW.introduction_id,
        'marketplace_' || NEW.event_type || '_' || NEW.decision
    )
    ON CONFLICT (source_type, source_id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_contact_projection_outbox
AFTER INSERT ON marketplace_introduction_contact_events
FOR EACH ROW EXECUTE FUNCTION enqueue_marketplace_contact_projection();

CREATE FUNCTION enqueue_marketplace_handoff_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO marketplace_conversion_outbox (
        id,
        tenant_id,
        source_type,
        source_id,
        aggregate_type,
        aggregate_id,
        event_type
    ) VALUES (
        pg_catalog.gen_random_uuid(),
        NEW.tenant_id,
        'sales_handoff',
        NEW.id,
        'marketplace_sales_handoff',
        NEW.id,
        'marketplace_sales_handoff_requested'
    )
    ON CONFLICT (source_type, source_id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_handoff_projection_outbox
AFTER INSERT ON marketplace_sales_handoffs
FOR EACH ROW EXECUTE FUNCTION enqueue_marketplace_handoff_projection();
