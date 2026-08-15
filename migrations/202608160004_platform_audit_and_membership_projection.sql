-- The Better Auth organization tables are the human identity authority.  These tables keep the
-- Rust marketplace authorization projection and the security-sensitive platform events in the
-- same PostgreSQL database so a capability cannot remain usable after a membership is revoked.

CREATE TABLE platform_audit_events (
    id uuid PRIMARY KEY,
    tenant_id uuid,
    domain_id uuid,
    platform_path text NOT NULL DEFAULT '/'
        CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$'),
    actor_auth_user_id uuid,
    actor_party_id uuid,
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
    outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
    request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 200),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_party_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (actor_auth_user_id) REFERENCES "user"(id)
);

CREATE INDEX platform_audit_events_scope_time_idx
    ON platform_audit_events (tenant_id, domain_id, platform_path, occurred_at DESC);

CREATE INDEX platform_audit_events_actor_time_idx
    ON platform_audit_events (actor_auth_user_id, occurred_at DESC);
