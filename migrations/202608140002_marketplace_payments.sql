-- Marketplace introductions, isolated payment routing, refunds, and invoices.

ALTER TABLE accounts ADD CONSTRAINT accounts_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE markets
    ADD COLUMN settlement_mode text NOT NULL DEFAULT 'online_platform'
        CHECK (settlement_mode IN ('online_platform', 'offline_direct')),
    ADD COLUMN offline_commission_collection text NOT NULL DEFAULT 'preauthorized'
        CHECK (offline_commission_collection IN ('preauthorized', 'postpaid')),
    ADD COLUMN commission_bps integer NOT NULL DEFAULT 100
        CHECK (commission_bps BETWEEN 0 AND 10000),
    ADD COLUMN platform_commission_account_id uuid,
    ADD CONSTRAINT markets_platform_commission_account_tenant_fk
        FOREIGN KEY (tenant_id, platform_commission_account_id) REFERENCES accounts(tenant_id, id);

ALTER TABLE trades
    ADD COLUMN gross_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (gross_amount >= 0 AND scale(gross_amount) = 0),
    ADD COLUMN commission_bps integer NOT NULL DEFAULT 0
        CHECK (commission_bps BETWEEN 0 AND 10000),
    ADD COLUMN commission_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (commission_amount >= 0 AND scale(commission_amount) = 0),
    ADD COLUMN seller_net_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (seller_net_amount >= 0 AND scale(seller_net_amount) = 0),
    ADD COLUMN platform_commission_account_id uuid,
    ADD CONSTRAINT trades_platform_commission_account_tenant_fk
        FOREIGN KEY (tenant_id, platform_commission_account_id) REFERENCES accounts(tenant_id, id),
    ADD CONSTRAINT trades_commission_totals_check
        CHECK (commission_amount <= gross_amount
            AND seller_net_amount + commission_amount = gross_amount);

UPDATE trades
SET gross_amount = price * quantity,
    seller_net_amount = price * quantity;

CREATE TABLE marketplace_parties (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 256),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    role text NOT NULL CHECK (role IN ('buyer', 'seller', 'both')),
    access_token_hash bytea NOT NULL CHECK (octet_length(access_token_hash) = 32),
    contact_ciphertext bytea NOT NULL,
    contact_nonce bytea NOT NULL CHECK (octet_length(contact_nonce) = 12),
    contact_key_version integer NOT NULL CHECK (contact_key_version > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, external_key),
    UNIQUE (tenant_id, access_token_hash),
    UNIQUE (tenant_id, id)
);

CREATE TABLE vehicle_listings (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    seller_party_id uuid NOT NULL,
    asking_amount numeric(38, 0) NOT NULL CHECK (asking_amount > 0 AND scale(asking_amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    commission_bps integer NOT NULL DEFAULT 100 CHECK (commission_bps BETWEEN 0 AND 10000),
    commission_collection text NOT NULL
        CHECK (commission_collection IN ('preauthorized', 'postpaid')),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'reserved', 'sold', 'withdrawn', 'expired')),
    published_at timestamptz,
    expires_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, asset_id) REFERENCES assets(tenant_id, domain_id, id),
    FOREIGN KEY (tenant_id, seller_party_id) REFERENCES marketplace_parties(tenant_id, id),
    CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at),
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX vehicle_listings_one_live_asset_idx
    ON vehicle_listings (tenant_id, asset_id)
    WHERE status IN ('active', 'reserved');
CREATE INDEX vehicle_listings_discovery_idx
    ON vehicle_listings (tenant_id, domain_id, status, asking_amount, published_at DESC);

CREATE TABLE buyer_vehicle_requests (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    buyer_party_id uuid NOT NULL,
    narrative text NOT NULL CHECK (length(narrative) BETWEEN 1 AND 10000),
    requirements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requirements) = 'object'),
    budget_min numeric(38, 0) CHECK (budget_min >= 0 AND scale(budget_min) = 0),
    budget_max numeric(38, 0) CHECK (budget_max > 0 AND scale(budget_max) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matched', 'closed', 'expired')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, buyer_party_id) REFERENCES marketplace_parties(tenant_id, id),
    CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max),
    UNIQUE (tenant_id, id)
);

CREATE INDEX buyer_vehicle_requests_active_idx
    ON buyer_vehicle_requests (tenant_id, domain_id, status, created_at DESC);

CREATE TABLE offline_deals (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    listing_id uuid NOT NULL,
    buyer_request_id uuid NOT NULL,
    seller_party_id uuid NOT NULL,
    buyer_party_id uuid NOT NULL,
    match_score double precision NOT NULL CHECK (match_score BETWEEN 0 AND 1),
    match_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(match_reasons) = 'array'),
    status text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'contact_released', 'viewing_scheduled', 'negotiating',
            'deal_pending', 'completed', 'declined', 'expired', 'disputed')),
    contact_released_at timestamptz,
    final_amount numeric(38, 0) CHECK (final_amount > 0 AND scale(final_amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    commission_bps integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
    commission_amount numeric(38, 0) CHECK (commission_amount >= 0 AND scale(commission_amount) = 0),
    commission_collection text NOT NULL CHECK (commission_collection IN ('preauthorized', 'postpaid')),
    seller_confirmed_at timestamptz,
    buyer_confirmed_at timestamptz,
    completed_at timestamptz,
    expires_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, listing_id) REFERENCES vehicle_listings(tenant_id, id),
    FOREIGN KEY (tenant_id, buyer_request_id) REFERENCES buyer_vehicle_requests(tenant_id, id),
    FOREIGN KEY (tenant_id, seller_party_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, buyer_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (listing_id, buyer_request_id),
    UNIQUE (tenant_id, id),
    CHECK (seller_party_id <> buyer_party_id),
    CHECK ((status = 'proposed' AND contact_released_at IS NULL)
        OR status <> 'proposed'),
    CHECK ((status = 'completed' AND seller_confirmed_at IS NOT NULL
            AND buyer_confirmed_at IS NOT NULL AND completed_at IS NOT NULL
            AND final_amount IS NOT NULL AND commission_amount IS NOT NULL)
        OR status <> 'completed')
);

CREATE INDEX offline_deals_participants_idx
    ON offline_deals (tenant_id, seller_party_id, buyer_party_id, status, created_at DESC);

CREATE TABLE contact_access_audit (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    offline_deal_id uuid NOT NULL,
    actor_party_id uuid NOT NULL,
    target_party_id uuid NOT NULL,
    decision text NOT NULL CHECK (decision IN ('allowed', 'denied')),
    purpose text NOT NULL CHECK (purpose IN ('match_contact', 'viewing', 'dispute')),
    request_fingerprint bytea CHECK (request_fingerprint IS NULL OR octet_length(request_fingerprint) = 32),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, offline_deal_id) REFERENCES offline_deals(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_party_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, target_party_id) REFERENCES marketplace_parties(tenant_id, id),
    CHECK (actor_party_id <> target_party_id)
);

CREATE INDEX contact_access_audit_deal_time_idx
    ON contact_access_audit (offline_deal_id, occurred_at DESC);

CREATE TABLE viewing_appointments (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    offline_deal_id uuid NOT NULL,
    proposed_by uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    location_ciphertext bytea NOT NULL,
    location_nonce bytea NOT NULL CHECK (octet_length(location_nonce) = 12),
    encryption_key_version integer NOT NULL CHECK (encryption_key_version > 0),
    status text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'completed', 'cancelled', 'no_show')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, offline_deal_id) REFERENCES offline_deals(tenant_id, id),
    FOREIGN KEY (tenant_id, proposed_by) REFERENCES marketplace_parties(tenant_id, id),
    CHECK (ends_at > starts_at)
);

CREATE TABLE offline_deal_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    offline_deal_id uuid NOT NULL,
    actor_party_id uuid,
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    from_status text,
    to_status text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, offline_deal_id) REFERENCES offline_deals(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_party_id) REFERENCES marketplace_parties(tenant_id, id)
);

CREATE INDEX offline_deal_events_deal_time_idx
    ON offline_deal_events (offline_deal_id, occurred_at DESC);

CREATE TABLE seller_exposure_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    listing_id uuid NOT NULL,
    viewer_party_id uuid,
    event_type text NOT NULL
        CHECK (event_type IN ('impression', 'detail_view', 'favorite', 'inquiry', 'matched_contact')),
    source text NOT NULL DEFAULT 'direct' CHECK (length(source) BETWEEN 1 AND 100),
    deduplication_key text NOT NULL CHECK (length(deduplication_key) BETWEEN 1 AND 200),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, listing_id) REFERENCES vehicle_listings(tenant_id, id),
    FOREIGN KEY (tenant_id, viewer_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, deduplication_key)
);

CREATE INDEX seller_exposure_events_listing_time_idx
    ON seller_exposure_events (listing_id, occurred_at DESC);

CREATE TABLE payment_gateway_configs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    gateway_kind text NOT NULL
        CHECK (gateway_kind IN ('test', 'epay', 'waffo_pancake', 'wechat_pay_v3',
            'alipay_openapi', 'custom')),
    mode text NOT NULL CHECK (mode IN ('test', 'production')),
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    credential_secret_ref text,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, name),
    UNIQUE (tenant_id, id),
    CHECK ((mode = 'test' AND gateway_kind = 'test' AND credential_secret_ref IS NULL)
        OR (mode = 'production' AND gateway_kind <> 'test' AND credential_secret_ref IS NOT NULL
            AND length(credential_secret_ref) BETWEEN 5 AND 2048))
);

CREATE TABLE payment_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    active_mode text NOT NULL DEFAULT 'test' CHECK (active_mode IN ('test', 'production')),
    updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE payment_routes (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    gateway_id uuid NOT NULL,
    method_code text NOT NULL CHECK (length(method_code) BETWEEN 1 AND 100),
    currency text NOT NULL DEFAULT '*' CHECK (currency = '*' OR currency ~ '^[A-Z]{3}$'),
    priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, gateway_id) REFERENCES payment_gateway_configs(tenant_id, id),
    UNIQUE (tenant_id, gateway_id, method_code, currency)
);

CREATE INDEX payment_routes_lookup_idx
    ON payment_routes (tenant_id, method_code, currency, priority) WHERE enabled;

CREATE TABLE payment_mode_audit (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    old_mode text NOT NULL CHECK (old_mode IN ('test', 'production')),
    new_mode text NOT NULL CHECK (new_mode IN ('test', 'production')),
    old_version bigint NOT NULL CHECK (old_version > 0),
    new_version bigint NOT NULL CHECK (new_version > 0),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (old_mode <> new_mode)
);

CREATE INDEX payment_mode_audit_tenant_time_idx
    ON payment_mode_audit (tenant_id, occurred_at DESC);

CREATE TABLE payment_config_audit (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
    action text NOT NULL CHECK (action IN ('gateway_created', 'gateway_updated',
        'route_created', 'route_updated')),
    target_type text NOT NULL CHECK (target_type IN ('gateway', 'route')),
    target_id uuid NOT NULL,
    before_value jsonb,
    after_value jsonb NOT NULL CHECK (jsonb_typeof(after_value) = 'object'),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (before_value IS NULL OR jsonb_typeof(before_value) = 'object')
);

CREATE INDEX payment_config_audit_tenant_time_idx
    ON payment_config_audit (tenant_id, occurred_at DESC);

CREATE TABLE payment_intents (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    gateway_id uuid NOT NULL,
    offline_deal_id uuid,
    payer_party_id uuid,
    merchant_order_id text NOT NULL CHECK (length(merchant_order_id) BETWEEN 1 AND 200),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    transaction_channel text NOT NULL
        CHECK (transaction_channel IN ('online_platform', 'offline_direct')),
    purpose text NOT NULL CHECK (purpose IN ('vehicle_purchase', 'platform_commission')),
    gateway_kind text NOT NULL
        CHECK (gateway_kind IN ('test', 'epay', 'waffo_pancake', 'wechat_pay_v3',
            'alipay_openapi', 'custom')),
    gateway_mode text NOT NULL CHECK (gateway_mode IN ('test', 'production')),
    payment_method text NOT NULL CHECK (length(payment_method) BETWEEN 1 AND 100),
    amount numeric(38, 0) NOT NULL CHECK (amount > 0 AND scale(amount) = 0),
    captured_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (captured_amount >= 0 AND scale(captured_amount) = 0),
    refunded_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (refunded_amount >= 0 AND scale(refunded_amount) = 0),
    commission_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (commission_amount >= 0 AND scale(commission_amount) = 0),
    commission_refunded_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (commission_refunded_amount >= 0 AND scale(commission_refunded_amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    status text NOT NULL
        CHECK (status IN ('requested', 'requires_action', 'authorized', 'pending', 'capture_pending',
            'captured', 'void_pending', 'voided', 'failed', 'unknown')),
    provider_reference text,
    redirect_url text,
    provider_status text NOT NULL DEFAULT 'created',
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, gateway_id) REFERENCES payment_gateway_configs(tenant_id, id),
    FOREIGN KEY (tenant_id, offline_deal_id) REFERENCES offline_deals(tenant_id, id),
    FOREIGN KEY (tenant_id, payer_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (tenant_id, merchant_order_id),
    UNIQUE (tenant_id, id),
    CHECK (captured_amount <= amount),
    CHECK (refunded_amount <= captured_amount),
    CHECK (commission_amount <= amount),
    CHECK (commission_refunded_amount <= commission_amount),
    CHECK (transaction_channel <> 'offline_direct' OR purpose = 'platform_commission'),
    CHECK ((offline_deal_id IS NOT NULL AND payer_party_id IS NOT NULL
            AND transaction_channel = 'offline_direct')
        OR (offline_deal_id IS NULL AND transaction_channel = 'online_platform'))
);

ALTER TABLE offline_deals ADD COLUMN commission_payment_id uuid;
ALTER TABLE offline_deals ADD CONSTRAINT offline_deals_commission_payment_fk
    FOREIGN KEY (tenant_id, commission_payment_id) REFERENCES payment_intents(tenant_id, id);

CREATE INDEX payment_intents_outstanding_idx
    ON payment_intents (tenant_id, gateway_mode, status, created_at)
    WHERE status IN ('requested', 'requires_action', 'authorized', 'pending', 'capture_pending',
        'void_pending', 'unknown');

CREATE TABLE payment_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    payment_id uuid NOT NULL,
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    from_status text,
    to_status text NOT NULL,
    provider_status text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment_intents(tenant_id, id)
);

CREATE INDEX payment_events_payment_time_idx
    ON payment_events (payment_id, occurred_at DESC);

CREATE TABLE payment_operations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    payment_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('capture', 'void', 'query')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    amount numeric(38, 0) CHECK (amount > 0 AND scale(amount) = 0),
    status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'unknown')),
    provider_status text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment_intents(tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    CHECK ((operation = 'capture' AND amount IS NOT NULL)
        OR (operation <> 'capture' AND amount IS NULL))
);

CREATE TABLE payment_refunds (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    payment_id uuid NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    amount numeric(38, 0) NOT NULL CHECK (amount > 0 AND scale(amount) = 0),
    commission_reversal_amount numeric(38, 0) NOT NULL
        CHECK (commission_reversal_amount >= 0 AND scale(commission_reversal_amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    status text NOT NULL CHECK (status IN ('requested', 'pending', 'succeeded', 'failed', 'unknown')),
    provider_reference text,
    provider_status text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment_intents(tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (tenant_id, id)
);

CREATE INDEX payment_refunds_payment_status_idx
    ON payment_refunds (payment_id, status, created_at DESC);

CREATE TABLE payment_webhook_inbox (
    gateway_id uuid NOT NULL REFERENCES payment_gateway_configs(id),
    provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 256),
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    provider_reference text,
    status text NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
    failure_reason text,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    PRIMARY KEY (gateway_id, provider_event_id)
);

CREATE TABLE invoice_provider_configs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 100),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    mode text NOT NULL CHECK (mode IN ('test', 'production')),
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    credential_secret_ref text,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, provider_key, mode),
    UNIQUE (tenant_id, id),
    CHECK ((mode = 'test' AND provider_key = 'local_test' AND credential_secret_ref IS NULL)
        OR (mode = 'production' AND provider_key <> 'local_test'
            AND credential_secret_ref IS NOT NULL
            AND length(credential_secret_ref) BETWEEN 5 AND 2048))
);

CREATE TABLE invoice_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    active_mode text NOT NULL DEFAULT 'test' CHECK (active_mode IN ('test', 'production')),
    active_provider_id uuid NOT NULL,
    updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, active_provider_id)
        REFERENCES invoice_provider_configs(tenant_id, id)
);

CREATE TABLE invoice_requests (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    payment_id uuid,
    offline_deal_id uuid,
    correction_of_invoice_id uuid,
    kind text NOT NULL CHECK (kind IN ('vehicle_sale', 'platform_commission')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    amount numeric(38, 0) NOT NULL CHECK (amount > 0 AND scale(amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
    billing_details_ciphertext bytea NOT NULL,
    billing_details_nonce bytea NOT NULL CHECK (octet_length(billing_details_nonce) = 12),
    encryption_key_version integer NOT NULL CHECK (encryption_key_version > 0),
    status text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'reviewing', 'issuing', 'issued', 'failed', 'voided',
            'red_letter_pending', 'red_lettered')),
    provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 100),
    provider_mode text NOT NULL CHECK (provider_mode IN ('test', 'production')),
    provider_reference text,
    invoice_number text,
    failure_reason text,
    requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 256),
    reviewed_by text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    issued_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment_intents(tenant_id, id),
    FOREIGN KEY (tenant_id, offline_deal_id) REFERENCES offline_deals(tenant_id, id),
    FOREIGN KEY (tenant_id, correction_of_invoice_id) REFERENCES invoice_requests(tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (tenant_id, id),
    UNIQUE (provider_key, provider_reference),
    CHECK ((kind = 'vehicle_sale' AND (payment_id IS NOT NULL OR offline_deal_id IS NOT NULL))
        OR (kind = 'platform_commission' AND payment_id IS NOT NULL)),
    CHECK (correction_of_invoice_id IS NULL OR status IN ('red_letter_pending', 'red_lettered'))
);

CREATE INDEX invoice_requests_tenant_status_idx
    ON invoice_requests (tenant_id, status, requested_at DESC);

CREATE TABLE invoice_artifacts (
    id uuid PRIMARY KEY,
    invoice_id uuid NOT NULL REFERENCES invoice_requests(id),
    artifact_kind text NOT NULL CHECK (artifact_kind IN ('invoice', 'credit_note', 'metadata')),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 200),
    storage_key text,
    inline_content_ciphertext bytea,
    content_nonce bytea CHECK (content_nonce IS NULL OR octet_length(content_nonce) = 12),
    encryption_key_version integer CHECK (encryption_key_version IS NULL OR encryption_key_version > 0),
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((storage_key IS NOT NULL)::integer + (inline_content_ciphertext IS NOT NULL)::integer = 1),
    CHECK ((inline_content_ciphertext IS NULL AND content_nonce IS NULL
            AND encryption_key_version IS NULL)
        OR (inline_content_ciphertext IS NOT NULL AND content_nonce IS NOT NULL
            AND encryption_key_version IS NOT NULL)),
    UNIQUE (invoice_id, artifact_kind)
);

CREATE TABLE invoice_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    invoice_id uuid NOT NULL REFERENCES invoice_requests(id),
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    from_status text,
    to_status text NOT NULL,
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice_requests(tenant_id, id)
);

CREATE INDEX invoice_events_invoice_time_idx
    ON invoice_events (invoice_id, occurred_at DESC);

CREATE TRIGGER marketplace_parties_updated_at
BEFORE UPDATE ON marketplace_parties FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER vehicle_listings_updated_at
BEFORE UPDATE ON vehicle_listings FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER buyer_vehicle_requests_updated_at
BEFORE UPDATE ON buyer_vehicle_requests FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER offline_deals_updated_at
BEFORE UPDATE ON offline_deals FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER viewing_appointments_updated_at
BEFORE UPDATE ON viewing_appointments FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER payment_gateway_configs_updated_at
BEFORE UPDATE ON payment_gateway_configs FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER payment_settings_updated_at
BEFORE UPDATE ON payment_settings FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER payment_routes_updated_at
BEFORE UPDATE ON payment_routes FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER payment_intents_updated_at
BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER payment_operations_updated_at
BEFORE UPDATE ON payment_operations FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER payment_refunds_updated_at
BEFORE UPDATE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER invoice_provider_configs_updated_at
BEFORE UPDATE ON invoice_provider_configs FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER invoice_settings_updated_at
BEFORE UPDATE ON invoice_settings FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER invoice_requests_updated_at
BEFORE UPDATE ON invoice_requests FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
