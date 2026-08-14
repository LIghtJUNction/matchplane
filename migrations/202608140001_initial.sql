-- MatchPlane canonical schema. PostgreSQL is the final source of truth.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE FUNCTION matchplane_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE domains (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, slug),
    UNIQUE (tenant_id, id)
);

CREATE TABLE asset_schemas (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    schema_document jsonb NOT NULL CHECK (jsonb_typeof(schema_document) = 'object'),
    schema_hash bytea NOT NULL CHECK (octet_length(schema_hash) = 32),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (tenant_id, domain_id, schema_version),
    UNIQUE (tenant_id, domain_id, id)
);

CREATE TABLE assets (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    asset_schema_id uuid NOT NULL,
    external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 256),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 500),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, asset_schema_id)
        REFERENCES asset_schemas(tenant_id, domain_id, id),
    UNIQUE (tenant_id, domain_id, external_key),
    UNIQUE (tenant_id, domain_id, id)
);

CREATE INDEX assets_attributes_gin_idx ON assets USING gin (attributes jsonb_path_ops);
CREATE INDEX assets_domain_status_idx ON assets (tenant_id, domain_id, status);

CREATE TABLE embedding_models (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 100),
    dimension integer NOT NULL CHECK (dimension BETWEEN 1 AND 65535),
    metric text NOT NULL CHECK (metric IN ('cosine', 'l2', 'inner_product')),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (tenant_id, domain_id, name, model_version),
    UNIQUE (id, dimension)
);

CREATE TABLE asset_embeddings (
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    embedding_model_id uuid NOT NULL,
    dimension integer NOT NULL,
    embedding vector NOT NULL,
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (asset_id, embedding_model_id, dimension),
    FOREIGN KEY (tenant_id, domain_id, asset_id) REFERENCES assets(tenant_id, domain_id, id),
    FOREIGN KEY (embedding_model_id, dimension) REFERENCES embedding_models(id, dimension),
    CHECK (vector_dims(embedding) = dimension)
) PARTITION BY LIST (dimension);

CREATE TABLE asset_embeddings_d384 PARTITION OF asset_embeddings FOR VALUES IN (384);
CREATE TABLE asset_embeddings_d3 PARTITION OF asset_embeddings FOR VALUES IN (3);
CREATE TABLE asset_embeddings_d768 PARTITION OF asset_embeddings FOR VALUES IN (768);
CREATE TABLE asset_embeddings_d1024 PARTITION OF asset_embeddings FOR VALUES IN (1024);
CREATE TABLE asset_embeddings_d1536 PARTITION OF asset_embeddings FOR VALUES IN (1536);
CREATE TABLE asset_embeddings_d3072 PARTITION OF asset_embeddings FOR VALUES IN (3072);
CREATE TABLE asset_embeddings_default PARTITION OF asset_embeddings DEFAULT;

CREATE INDEX asset_embeddings_d3_cosine_hnsw_idx
    ON asset_embeddings_d3 USING hnsw ((embedding::vector(3)) vector_cosine_ops);
CREATE INDEX asset_embeddings_d3_l2_hnsw_idx
    ON asset_embeddings_d3 USING hnsw ((embedding::vector(3)) vector_l2_ops);
CREATE INDEX asset_embeddings_d3_ip_hnsw_idx
    ON asset_embeddings_d3 USING hnsw ((embedding::vector(3)) vector_ip_ops);
CREATE INDEX asset_embeddings_d384_cosine_hnsw_idx
    ON asset_embeddings_d384 USING hnsw ((embedding::vector(384)) vector_cosine_ops);
CREATE INDEX asset_embeddings_d384_l2_hnsw_idx
    ON asset_embeddings_d384 USING hnsw ((embedding::vector(384)) vector_l2_ops);
CREATE INDEX asset_embeddings_d384_ip_hnsw_idx
    ON asset_embeddings_d384 USING hnsw ((embedding::vector(384)) vector_ip_ops);
CREATE INDEX asset_embeddings_d768_cosine_hnsw_idx
    ON asset_embeddings_d768 USING hnsw ((embedding::vector(768)) vector_cosine_ops);
CREATE INDEX asset_embeddings_d768_l2_hnsw_idx
    ON asset_embeddings_d768 USING hnsw ((embedding::vector(768)) vector_l2_ops);
CREATE INDEX asset_embeddings_d768_ip_hnsw_idx
    ON asset_embeddings_d768 USING hnsw ((embedding::vector(768)) vector_ip_ops);
CREATE INDEX asset_embeddings_d1024_cosine_hnsw_idx
    ON asset_embeddings_d1024 USING hnsw ((embedding::vector(1024)) vector_cosine_ops);
CREATE INDEX asset_embeddings_d1024_l2_hnsw_idx
    ON asset_embeddings_d1024 USING hnsw ((embedding::vector(1024)) vector_l2_ops);
CREATE INDEX asset_embeddings_d1024_ip_hnsw_idx
    ON asset_embeddings_d1024 USING hnsw ((embedding::vector(1024)) vector_ip_ops);
CREATE INDEX asset_embeddings_d1536_cosine_hnsw_idx
    ON asset_embeddings_d1536 USING hnsw ((embedding::vector(1536)) vector_cosine_ops);
CREATE INDEX asset_embeddings_d1536_l2_hnsw_idx
    ON asset_embeddings_d1536 USING hnsw ((embedding::vector(1536)) vector_l2_ops);
CREATE INDEX asset_embeddings_d1536_ip_hnsw_idx
    ON asset_embeddings_d1536 USING hnsw ((embedding::vector(1536)) vector_ip_ops);
CREATE INDEX asset_embeddings_d3072_cosine_hnsw_idx
    ON asset_embeddings_d3072 USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
CREATE INDEX asset_embeddings_d3072_l2_hnsw_idx
    ON asset_embeddings_d3072 USING hnsw ((embedding::halfvec(3072)) halfvec_l2_ops);
CREATE INDEX asset_embeddings_d3072_ip_hnsw_idx
    ON asset_embeddings_d3072 USING hnsw ((embedding::halfvec(3072)) halfvec_ip_ops);

CREATE TABLE federation_nodes (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
    grpc_endpoint text NOT NULL CHECK (length(grpc_endpoint) BETWEEN 1 AND 2048),
    signing_key text NOT NULL CHECK (length(signing_key) BETWEEN 1 AND 8192),
    certificate_fingerprint text,
    protocol_major integer NOT NULL CHECK (protocol_major > 0),
    protocol_minor integer NOT NULL CHECK (protocol_minor >= 0),
    fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantined', 'disabled')),
    last_seen_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE markets (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    shard_id uuid NOT NULL UNIQUE,
    symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9][A-Z0-9._/-]{1,63}$'),
    base_asset_key text NOT NULL CHECK (length(base_asset_key) BETWEEN 1 AND 256),
    quote_asset_key text NOT NULL CHECK (length(quote_asset_key) BETWEEN 1 AND 256),
    price_scale smallint NOT NULL CHECK (price_scale BETWEEN 0 AND 18),
    quantity_scale smallint NOT NULL CHECK (quantity_scale BETWEEN 0 AND 18),
    kafka_partition integer NOT NULL CHECK (kafka_partition >= 0),
    routing_epoch bigint NOT NULL DEFAULT 1 CHECK (routing_epoch > 0),
    next_command_sequence bigint NOT NULL DEFAULT 1 CHECK (next_command_sequence > 0),
    next_event_sequence bigint NOT NULL DEFAULT 1 CHECK (next_event_sequence > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'halted', 'closed')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (tenant_id, domain_id, symbol),
    UNIQUE (tenant_id, domain_id, id),
    UNIQUE (id, shard_id)
    ,CHECK (base_asset_key <> quote_asset_key)
);

CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    owner_key text NOT NULL CHECK (length(owner_key) BETWEEN 1 AND 256),
    asset_key text NOT NULL CHECK (length(asset_key) BETWEEN 1 AND 256),
    available_amount numeric(38, 0) NOT NULL DEFAULT 0 CHECK (available_amount >= 0),
    reserved_amount numeric(38, 0) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, owner_key, asset_key)
);

CREATE TABLE orders (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    market_id uuid NOT NULL,
    reservation_account_id uuid NOT NULL REFERENCES accounts(id),
    settlement_account_id uuid NOT NULL REFERENCES accounts(id),
    side text NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type text NOT NULL DEFAULT 'limit' CHECK (order_type = 'limit'),
    price numeric(38, 0) NOT NULL CHECK (price > 0 AND scale(price) = 0),
    original_quantity numeric(38, 0) NOT NULL CHECK (original_quantity > 0 AND scale(original_quantity) = 0),
    remaining_quantity numeric(38, 0) NOT NULL CHECK (remaining_quantity >= 0 AND scale(remaining_quantity) = 0),
    federated_reserved_quantity numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (federated_reserved_quantity >= 0 AND scale(federated_reserved_quantity) = 0),
    status text NOT NULL CHECK (status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected')),
    accepted_sequence bigint CHECK (accepted_sequence > 0),
    command_event_id uuid NOT NULL UNIQUE,
    command_sequence bigint NOT NULL CHECK (command_sequence > 0),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    idempotency_payload_hash bytea NOT NULL CHECK (octet_length(idempotency_payload_hash) = 32),
    submitted_at timestamptz NOT NULL,
    expires_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, market_id) REFERENCES markets(tenant_id, domain_id, id),
    UNIQUE (tenant_id, idempotency_key),
    CHECK (remaining_quantity <= original_quantity),
    CHECK (federated_reserved_quantity <= remaining_quantity),
    CHECK (expires_at IS NULL OR expires_at > submitted_at),
    CHECK ((status IN ('filled', 'cancelled', 'expired') AND remaining_quantity = 0)
        OR status NOT IN ('filled', 'cancelled', 'expired'))
);

CREATE INDEX orders_market_status_price_idx ON orders (market_id, status, side, price, accepted_sequence);
CREATE INDEX orders_tenant_created_idx ON orders (tenant_id, created_at DESC);

CREATE TABLE command_log (
    event_id uuid PRIMARY KEY,
    correlation_id uuid NOT NULL,
    causation_id uuid NOT NULL,
    source_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    market_id uuid NOT NULL,
    shard_id uuid NOT NULL,
    shard_sequence bigint NOT NULL CHECK (shard_sequence > 0),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    occurred_at timestamptz NOT NULL,
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    command_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, market_id) REFERENCES markets(tenant_id, domain_id, id),
    FOREIGN KEY (market_id, shard_id) REFERENCES markets(id, shard_id),
    UNIQUE (source_node_id, shard_id, shard_sequence)
);

CREATE TABLE reservations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    order_id uuid NOT NULL REFERENCES orders(id),
    account_id uuid NOT NULL REFERENCES accounts(id),
    quantity numeric(38, 0) NOT NULL CHECK (quantity > 0 AND scale(quantity) = 0),
    remaining_quantity numeric(38, 0) NOT NULL CHECK (remaining_quantity >= 0 AND scale(remaining_quantity) = 0),
    status text NOT NULL CHECK (status IN ('pending', 'held', 'confirmed', 'aborted', 'expired')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    fencing_token bigint NOT NULL CHECK (fencing_token >= 0),
    expires_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (order_id),
    CHECK (remaining_quantity <= quantity)
);

CREATE INDEX reservations_expiry_idx ON reservations (status, expires_at)
    WHERE status IN ('pending', 'held');

CREATE TABLE federation_saga_reservations (
    id uuid PRIMARY KEY,
    source_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    market_id uuid NOT NULL,
    order_id uuid NOT NULL REFERENCES orders(id),
    quantity numeric(38, 0) NOT NULL CHECK (quantity > 0 AND scale(quantity) = 0),
    status text NOT NULL CHECK (status IN ('reserved', 'confirmed', 'aborted', 'expired')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    fencing_token bigint NOT NULL CHECK (fencing_token > 0),
    nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
    expires_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, market_id) REFERENCES markets(tenant_id, domain_id, id),
    UNIQUE (source_node_id, idempotency_key),
    UNIQUE (source_node_id, nonce),
    CHECK (expires_at > created_at)
);

CREATE INDEX federation_saga_reservations_expiry_idx
    ON federation_saga_reservations (status, expires_at) WHERE status = 'reserved';

CREATE TABLE federation_replay_nonces (
    source_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    nonce text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 256),
    operation text NOT NULL CHECK (operation IN ('negotiate', 'confirm', 'abort')),
    reservation_id uuid REFERENCES federation_saga_reservations(id),
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source_node_id, nonce),
    CHECK ((operation = 'negotiate' AND reservation_id IS NULL)
        OR (operation IN ('confirm', 'abort') AND reservation_id IS NOT NULL))
);

CREATE INDEX federation_replay_nonces_seen_idx
    ON federation_replay_nonces (first_seen_at DESC);

CREATE TABLE trades (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    market_id uuid NOT NULL,
    event_id uuid NOT NULL UNIQUE,
    maker_order_id uuid NOT NULL REFERENCES orders(id),
    taker_order_id uuid NOT NULL REFERENCES orders(id),
    buy_order_id uuid NOT NULL REFERENCES orders(id),
    sell_order_id uuid NOT NULL REFERENCES orders(id),
    price numeric(38, 0) NOT NULL CHECK (price > 0 AND scale(price) = 0),
    quantity numeric(38, 0) NOT NULL CHECK (quantity > 0 AND scale(quantity) = 0),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, market_id) REFERENCES markets(tenant_id, domain_id, id),
    CHECK (maker_order_id <> taker_order_id),
    CHECK (buy_order_id <> sell_order_id)
);

CREATE INDEX trades_market_time_idx ON trades (market_id, occurred_at DESC);

CREATE TABLE ledger_entries (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    trade_id uuid NOT NULL REFERENCES trades(id),
    account_id uuid NOT NULL REFERENCES accounts(id),
    entry_group_id uuid NOT NULL,
    entry_kind text NOT NULL CHECK (entry_kind IN ('debit', 'credit')),
    amount numeric(38, 0) NOT NULL CHECK (amount > 0 AND scale(amount) = 0),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (entry_group_id, account_id, entry_kind)
);

CREATE INDEX ledger_entries_trade_idx ON ledger_entries (trade_id);
CREATE INDEX ledger_entries_account_time_idx ON ledger_entries (account_id, occurred_at DESC);

CREATE TABLE domain_events (
    event_id uuid PRIMARY KEY,
    correlation_id uuid NOT NULL,
    causation_id uuid NOT NULL,
    source_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    market_id uuid NOT NULL,
    shard_id uuid NOT NULL,
    shard_sequence bigint NOT NULL CHECK (shard_sequence > 0),
    stream_kind text NOT NULL CHECK (stream_kind IN ('domain_event', 'order_book_delta', 'market_summary', 'federation', 'node_health')),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    event_type text NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    payload jsonb NOT NULL,
    fencing_token bigint NOT NULL CHECK (fencing_token >= 0),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, market_id) REFERENCES markets(tenant_id, domain_id, id),
    FOREIGN KEY (market_id, shard_id) REFERENCES markets(id, shard_id),
    UNIQUE (source_node_id, shard_id, stream_kind, shard_sequence)
);

CREATE INDEX domain_events_replay_idx
    ON domain_events (source_node_id, shard_id, stream_kind, shard_sequence);
CREATE INDEX domain_events_market_time_idx ON domain_events (market_id, occurred_at DESC);

CREATE TABLE outbox_events (
    event_id uuid PRIMARY KEY,
    correlation_id uuid NOT NULL,
    causation_id uuid NOT NULL,
    source_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    market_id uuid NOT NULL,
    shard_id uuid NOT NULL,
    shard_sequence bigint NOT NULL CHECK (shard_sequence > 0),
    stream_kind text NOT NULL CHECK (stream_kind IN ('command', 'domain_event', 'order_book_delta', 'market_summary', 'federation', 'node_health')),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    occurred_at timestamptz NOT NULL,
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    topic text NOT NULL,
    message_key text NOT NULL,
    payload bytea NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claimed_at timestamptz,
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id, market_id) REFERENCES markets(tenant_id, domain_id, id),
    FOREIGN KEY (market_id, shard_id) REFERENCES markets(id, shard_id),
    UNIQUE (source_node_id, shard_id, stream_kind, shard_sequence)
);

CREATE INDEX outbox_pending_idx ON outbox_events (available_at, created_at)
    WHERE status IN ('pending', 'failed');

CREATE TABLE consumer_inbox (
    consumer_name text NOT NULL,
    event_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    shard_id uuid NOT NULL,
    shard_sequence bigint NOT NULL CHECK (shard_sequence > 0),
    stream_kind text NOT NULL,
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'applied', 'failed')),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_at timestamptz,
    last_error text,
    PRIMARY KEY (consumer_name, event_id)
);

CREATE INDEX consumer_inbox_recovery_idx ON consumer_inbox (consumer_name, status, received_at);

CREATE TABLE order_book_snapshots (
    id uuid PRIMARY KEY,
    market_id uuid NOT NULL,
    shard_id uuid NOT NULL,
    last_event_sequence bigint NOT NULL CHECK (last_event_sequence >= 0),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 100),
    state bytea NOT NULL,
    checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (market_id, shard_id) REFERENCES markets(id, shard_id),
    UNIQUE (market_id, last_event_sequence)
);

CREATE INDEX order_book_snapshots_latest_idx
    ON order_book_snapshots (market_id, last_event_sequence DESC);

CREATE TABLE federation_subscriptions (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES federation_nodes(id),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    market_id uuid,
    stream_kind text NOT NULL CHECK (stream_kind IN ('order_book_delta', 'market_summary', 'node_health')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
    protocol_major integer NOT NULL CHECK (protocol_major > 0),
    protocol_minor integer NOT NULL CHECK (protocol_minor >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    UNIQUE NULLS NOT DISTINCT (node_id, tenant_id, domain_id, market_id, stream_kind)
);

CREATE TABLE shard_leases (
    market_id uuid PRIMARY KEY,
    shard_id uuid NOT NULL,
    owner_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    owner_instance_id text NOT NULL CHECK (length(owner_instance_id) BETWEEN 1 AND 256),
    fencing_token bigint NOT NULL CHECK (fencing_token > 0),
    routing_epoch bigint NOT NULL CHECK (routing_epoch > 0),
    acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (market_id, shard_id) REFERENCES markets(id, shard_id),
    CHECK (expires_at > acquired_at)
);

CREATE INDEX shard_leases_expiry_idx ON shard_leases (expires_at);

CREATE TABLE market_observations (
    market_id uuid NOT NULL REFERENCES markets(id),
    source_node_id uuid NOT NULL REFERENCES federation_nodes(id),
    observed_at timestamptz NOT NULL,
    shard_sequence bigint NOT NULL CHECK (shard_sequence > 0),
    best_bid_price numeric(38, 0),
    best_bid_quantity numeric(38, 0),
    best_ask_price numeric(38, 0),
    best_ask_quantity numeric(38, 0),
    trade_count bigint NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
    PRIMARY KEY (market_id, source_node_id, observed_at, shard_sequence),
    CHECK (best_bid_price IS NULL OR best_bid_price > 0),
    CHECK (best_ask_price IS NULL OR best_ask_price > 0),
    CHECK (best_bid_quantity IS NULL OR best_bid_quantity >= 0),
    CHECK (best_ask_quantity IS NULL OR best_ask_quantity >= 0)
);

SELECT create_hypertable(
    'market_observations',
    by_range('observed_at', INTERVAL '1 day'),
    if_not_exists => true
);

CREATE INDEX market_observations_latest_idx
    ON market_observations (market_id, observed_at DESC);

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER domains_set_updated_at BEFORE UPDATE ON domains
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER asset_embeddings_set_updated_at BEFORE UPDATE ON asset_embeddings
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER federation_nodes_set_updated_at BEFORE UPDATE ON federation_nodes
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER markets_set_updated_at BEFORE UPDATE ON markets
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER reservations_set_updated_at BEFORE UPDATE ON reservations
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER federation_saga_reservations_set_updated_at
    BEFORE UPDATE ON federation_saga_reservations
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
CREATE TRIGGER federation_subscriptions_set_updated_at BEFORE UPDATE ON federation_subscriptions
    FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
