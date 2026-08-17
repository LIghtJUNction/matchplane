-- A short-lived database claim replaces the old session advisory lock that was held
-- across the hosted routing request.  The row serializes retries without pinning a
-- PostgreSQL connection while the model provider is contacted.
CREATE TABLE platform_match_idempotency_claims (
    auth_user_id text NOT NULL CHECK (length(auth_user_id) BETWEEN 1 AND 200),
    platform_path text NOT NULL CHECK (
        platform_path = '/'
        OR platform_path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$'
    ),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
    request_id uuid NOT NULL UNIQUE,
    narrative_hash text NOT NULL CHECK (narrative_hash ~ '^[0-9a-f]{64}$'),
    state text NOT NULL DEFAULT 'processing'
        CHECK (state IN ('processing', 'completed', 'failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (auth_user_id, platform_path, idempotency_key)
);

CREATE INDEX platform_match_idempotency_claims_state_idx
    ON platform_match_idempotency_claims (state, updated_at);
