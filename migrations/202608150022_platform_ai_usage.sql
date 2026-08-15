-- Every model call made by the platform router is paid for by the deployment
-- platform.  Keep a small, provider-neutral usage ledger so operators can
-- reconcile spend without putting raw prompts, credentials, or provider URLs
-- into tenant data.
CREATE TABLE platform_ai_usage (
    id uuid PRIMARY KEY,
    match_request_id uuid NOT NULL REFERENCES platform_match_requests(id) ON DELETE CASCADE,
    auth_user_id text NOT NULL CHECK (length(auth_user_id) BETWEEN 1 AND 200),
    platform_path text NOT NULL CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(?:/[a-z0-9-]+)*$'),
    source text NOT NULL CHECK (source IN ('ai', 'policy_fallback')),
    cost_bearer text NOT NULL DEFAULT 'platform' CHECK (cost_bearer = 'platform'),
    model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
    max_input_characters integer NOT NULL CHECK (max_input_characters BETWEEN 1 AND 100000),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 2048),
    prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens BETWEEN 0 AND 2000000),
    completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens BETWEEN 0 AND 2048),
    total_tokens integer CHECK (total_tokens IS NULL OR total_tokens BETWEEN 0 AND 2002048),
    degraded boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (match_request_id)
);

CREATE INDEX platform_ai_usage_user_idx
    ON platform_ai_usage (auth_user_id, created_at DESC);

CREATE INDEX platform_ai_usage_platform_idx
    ON platform_ai_usage (platform_path, created_at DESC);

ALTER TABLE platform_match_requests
    ADD CONSTRAINT platform_match_requests_routing_cost_bearer_check
    CHECK (
        routing_decision = '{}'::jsonb
        OR routing_decision ->> 'costBearer' = 'platform'
    );
