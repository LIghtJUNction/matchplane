-- Seller-submitted supply is durably stored before an operator publishes it.
-- The root platform accepts subplatform-defined JSON attributes, but never invents
-- a vertical's fields or sample inventory.

CREATE TABLE marketplace_listing_submissions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    seller_party_id uuid NOT NULL,
    asset_schema_id uuid NOT NULL,
    external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 256),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 500),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(attributes) = 'object'),
    asking_amount numeric(38, 0) NOT NULL
        CHECK (asking_amount > 0 AND scale(asking_amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    status text NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'approved', 'rejected', 'withdrawn')),
    reviewed_by text,
    review_reason text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, asset_schema_id)
        REFERENCES asset_schemas(tenant_id, domain_id, id),
    FOREIGN KEY (tenant_id, seller_party_id)
        REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, domain_id, id),
    UNIQUE (tenant_id, domain_id, seller_party_id, external_key),
    CHECK ((status = 'pending_review' AND reviewed_by IS NULL)
        OR (status IN ('approved', 'rejected', 'withdrawn')))
);

CREATE INDEX marketplace_listing_submissions_seller_idx
    ON marketplace_listing_submissions (tenant_id, seller_party_id, status, created_at DESC);

CREATE INDEX marketplace_listing_submissions_domain_idx
    ON marketplace_listing_submissions (tenant_id, domain_id, status, created_at DESC);

CREATE TRIGGER marketplace_listing_submissions_updated_at
BEFORE UPDATE ON marketplace_listing_submissions
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
