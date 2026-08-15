-- Reserve hosted provider calls atomically before they leave the platform.
-- Rows are retained briefly for audit/quota accounting and are queried only by
-- the rolling one-hour admission window.
CREATE TABLE platform_ai_call_admissions (
    id uuid PRIMARY KEY,
    auth_user_id text NOT NULL CHECK (length(auth_user_id) BETWEEN 1 AND 200),
    request_id uuid NOT NULL,
    platform_path text NOT NULL CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(?:/[a-z0-9-]+)*$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX platform_ai_call_admissions_user_idx
    ON platform_ai_call_admissions (auth_user_id, created_at DESC);

CREATE INDEX platform_ai_call_admissions_request_idx
    ON platform_ai_call_admissions (request_id);
