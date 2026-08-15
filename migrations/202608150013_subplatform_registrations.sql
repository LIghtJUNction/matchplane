-- Immutable source/build records for root-managed subplatform registration.
CREATE TABLE subplatform_registrations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    package_id text NOT NULL CHECK (package_id ~ '^[a-z0-9][a-z0-9._-]{1,127}$'),
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    source_kind text NOT NULL CHECK (source_kind IN ('git', 'archive')),
    source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 2048),
    pinned_revision text NOT NULL CHECK (length(pinned_revision) BETWEEN 1 AND 256),
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
    build_digest bytea CHECK (build_digest IS NULL OR octet_length(build_digest) = 32),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    requested_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
    state text NOT NULL DEFAULT 'received'
        CHECK (state IN ('received', 'validated', 'building', 'ready', 'active', 'disabled', 'rejected')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    registered_by text NOT NULL CHECK (length(registered_by) BETWEEN 1 AND 200),
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (tenant_id, slug, version),
    UNIQUE (tenant_id, package_id, source_digest)
);

CREATE INDEX subplatform_registrations_active_idx
    ON subplatform_registrations (tenant_id, slug, state, version DESC);

CREATE TRIGGER subplatform_registrations_updated_at
BEFORE UPDATE ON subplatform_registrations
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
