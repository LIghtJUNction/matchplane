-- Bounded, caller-funded Agent handoffs.  The platform stores the protocol
-- envelope and the authorized next hops; it never executes the caller's model.
CREATE TABLE platform_agent_handoffs (
    request_id uuid PRIMARY KEY,
    auth_subject text NOT NULL CHECK (length(auth_subject) BETWEEN 1 AND 200),
    organization_id uuid REFERENCES "organization"(id) ON DELETE SET NULL,
    platform_path text NOT NULL CHECK (
        platform_path = '/'
        OR platform_path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$'
    ),
    stage text NOT NULL CHECK (stage IN ('platform', 'merchant', 'inventory')),
    narrative text NOT NULL CHECK (length(narrative) BETWEEN 1 AND 10000),
    requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'object'),
    agent jsonb NOT NULL CHECK (jsonb_typeof(agent) = 'object'),
    budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
    selected_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_refs) = 'array'),
    status text NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('accepted', 'completed', 'expired', 'rejected')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX platform_agent_handoffs_subject_idx
    ON platform_agent_handoffs (auth_subject, created_at DESC);

CREATE INDEX platform_agent_handoffs_expiry_idx
    ON platform_agent_handoffs (expires_at, status);

CREATE TRIGGER platform_agent_handoffs_updated_at
BEFORE UPDATE ON platform_agent_handoffs
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
