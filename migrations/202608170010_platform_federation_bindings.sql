-- Durable trust records for platforms that run outside this deployment.
-- A one-time invite proves possession of the enrollment token; the remote Ed25519 signature
-- proves which node published the manifest. Neither record grants runtime access by itself.

ALTER TABLE subplatform_registrations
    DROP CONSTRAINT IF EXISTS subplatform_registrations_source_kind_check;

ALTER TABLE subplatform_registrations
    ADD CONSTRAINT subplatform_registrations_source_kind_check
    CHECK (source_kind IN ('git', 'archive', 'remote'));

CREATE TABLE platform_federation_invites (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    parent_organization_id uuid NOT NULL REFERENCES "organization"(id),
    domain_id uuid NOT NULL,
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    used_by_node_id uuid,
    created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (token_hash),
    CHECK (expires_at > created_at)
);

CREATE INDEX platform_federation_invites_active_idx
    ON platform_federation_invites (tenant_id, expires_at)
    WHERE used_at IS NULL;

CREATE TABLE platform_federation_bindings (
    id uuid PRIMARY KEY,
    invite_id uuid NOT NULL UNIQUE REFERENCES platform_federation_invites(id),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    parent_organization_id uuid NOT NULL REFERENCES "organization"(id),
    organization_id uuid UNIQUE REFERENCES "organization"(id),
    registration_id uuid UNIQUE,
    node_id uuid NOT NULL UNIQUE,
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
    mcp_server_key text NOT NULL CHECK (mcp_server_key ~ '^[a-z0-9][a-z0-9._:-]{1,127}$'),
    public_key text NOT NULL CHECK (length(public_key) BETWEEN 32 AND 8192),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
    signature text NOT NULL CHECK (length(signature) BETWEEN 32 AND 8192),
    token_env text CHECK (token_env IS NULL OR token_env ~ '^[A-Z][A-Z0-9_]{0,127}$'),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'degraded', 'revoked')),
    last_health_at timestamptz,
    last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 4000),
    created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
    activated_by text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (tenant_id, mcp_server_key)
);

ALTER TABLE subplatform_registrations
    ADD COLUMN federation_binding_id uuid UNIQUE;

ALTER TABLE platform_federation_bindings
    ADD CONSTRAINT platform_federation_bindings_registration_fk
    FOREIGN KEY (registration_id) REFERENCES subplatform_registrations(id);

CREATE INDEX platform_federation_bindings_scope_idx
    ON platform_federation_bindings (tenant_id, parent_organization_id, status);

CREATE TRIGGER platform_federation_bindings_set_updated_at
BEFORE UPDATE ON platform_federation_bindings
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
