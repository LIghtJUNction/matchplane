-- Domain-neutral chat requests accepted by a platform node before they are
-- delegated to one or more child platforms. The matching kernel remains the
-- owner of domain-specific buyer requests; this table records the recursive
-- routing envelope and prevents the root chat from silently dropping intent.
CREATE TABLE platform_match_requests (
    id uuid PRIMARY KEY,
    auth_user_id text NOT NULL CHECK (length(auth_user_id) BETWEEN 1 AND 200),
    platform_path text NOT NULL CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(?:/[a-z0-9-]+)*$'),
    narrative text NOT NULL CHECK (length(narrative) BETWEEN 1 AND 10000),
    route_plan jsonb NOT NULL CHECK (jsonb_typeof(route_plan) = 'array'),
    status text NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('accepted', 'delegated', 'completed', 'degraded', 'failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX platform_match_requests_user_idx
    ON platform_match_requests (auth_user_id, created_at DESC);

CREATE INDEX platform_match_requests_path_idx
    ON platform_match_requests (platform_path, created_at DESC);

CREATE TRIGGER platform_match_requests_updated_at
BEFORE UPDATE ON platform_match_requests
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
