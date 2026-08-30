-- Privacy-bounded acquisition links and anonymous landing attribution.
--
-- Raw link and browser-subject tokens never cross this schema boundary.  The only correlation
-- material retained here is a fixed-size SHA-256 digest; touchpoints deliberately have no payload
-- column that could collect headers, network addresses, contact details, or authenticated identity.

-- A scoped acquisition link must prove that its offer belongs to the same tenant, domain, and
-- canonical store.  marketplace_offers.id is already globally unique, but PostgreSQL requires a
-- matching composite unique key for the scope-preserving foreign key below.
ALTER TABLE marketplace_offers
    ADD CONSTRAINT marketplace_offers_acquisition_scope_uidx
    UNIQUE (tenant_id, domain_id, store_id, id);

CREATE TABLE marketplace_acquisition_links (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    store_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    token_digest bytea NOT NULL,
    channel_key text NOT NULL,
    source_ref text,
    campaign_ref text,
    status text NOT NULL DEFAULT 'active',
    expires_at timestamptz,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT marketplace_acquisition_links_token_digest_size
        CHECK (octet_length(token_digest) = 32),
    CONSTRAINT marketplace_acquisition_links_channel_key_format
        CHECK (channel_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CONSTRAINT marketplace_acquisition_links_source_ref_bounds
        CHECK (source_ref IS NULL OR (
            length(source_ref) BETWEEN 1 AND 128
            AND source_ref = btrim(source_ref)
            AND source_ref !~ '[[:cntrl:]]'
        )),
    CONSTRAINT marketplace_acquisition_links_campaign_ref_bounds
        CHECK (campaign_ref IS NULL OR (
            length(campaign_ref) BETWEEN 1 AND 128
            AND campaign_ref = btrim(campaign_ref)
            AND campaign_ref !~ '[[:cntrl:]]'
        )),
    CONSTRAINT marketplace_acquisition_links_status_check
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT marketplace_acquisition_links_expiry_check
        CHECK (expires_at IS NULL OR expires_at > created_at),
    CONSTRAINT marketplace_acquisition_links_version_check
        CHECK (version > 0),
    CONSTRAINT marketplace_acquisition_links_tenant_id_id_unique
        UNIQUE (tenant_id, id),
    CONSTRAINT marketplace_acquisition_links_token_digest_unique
        UNIQUE (token_digest),
    CONSTRAINT marketplace_acquisition_links_domain_fk
        FOREIGN KEY (tenant_id, domain_id)
        REFERENCES domains(tenant_id, id),
    CONSTRAINT marketplace_acquisition_links_store_scope_fk
        FOREIGN KEY (tenant_id, domain_id, store_id)
        REFERENCES stores(tenant_id, domain_id, id),
    CONSTRAINT marketplace_acquisition_links_offer_scope_fk
        FOREIGN KEY (tenant_id, domain_id, store_id, offer_id)
        REFERENCES marketplace_offers(tenant_id, domain_id, store_id, id)
);

CREATE INDEX marketplace_acquisition_links_store_created_idx
    ON marketplace_acquisition_links (tenant_id, store_id, created_at DESC);

CREATE INDEX marketplace_acquisition_links_offer_status_idx
    ON marketplace_acquisition_links (tenant_id, offer_id, status, created_at DESC);

CREATE INDEX marketplace_acquisition_links_active_token_idx
    ON marketplace_acquisition_links (token_digest)
    WHERE status = 'active';

CREATE TRIGGER marketplace_acquisition_links_updated_at
    BEFORE UPDATE ON marketplace_acquisition_links
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TABLE marketplace_acquisition_touchpoints (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    link_id uuid NOT NULL,
    anonymous_subject_digest bytea NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT marketplace_acquisition_touchpoints_subject_digest_size
        CHECK (octet_length(anonymous_subject_digest) = 32),
    CONSTRAINT marketplace_acquisition_touchpoints_event_type_check
        CHECK (event_type = 'landing_viewed'),
    CONSTRAINT marketplace_acquisition_touchpoints_landing_idempotency
        UNIQUE (tenant_id, link_id, anonymous_subject_digest, event_type),
    CONSTRAINT marketplace_acquisition_touchpoints_link_scope_fk
        FOREIGN KEY (tenant_id, link_id)
        REFERENCES marketplace_acquisition_links(tenant_id, id)
);

CREATE INDEX marketplace_acquisition_touchpoints_link_time_idx
    ON marketplace_acquisition_touchpoints (tenant_id, link_id, occurred_at DESC);
