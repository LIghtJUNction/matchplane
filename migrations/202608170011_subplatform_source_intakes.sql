-- Source-only subplatform intake.  The isolated builder discovers and validates the
-- package manifest before the root creates a Better Auth organization or registration.
CREATE TABLE subplatform_source_intakes (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    domain_id uuid NOT NULL,
    parent_organization_id uuid,
    source_kind text NOT NULL CHECK (source_kind IN ('git', 'archive')),
    source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 2048),
    source_digest bytea CHECK (source_digest IS NULL OR octet_length(source_digest) = 32),
    pinned_revision text CHECK (pinned_revision IS NULL OR length(pinned_revision) BETWEEN 1 AND 256),
    manifest jsonb CHECK (manifest IS NULL OR jsonb_typeof(manifest) = 'object'),
    manifest_digest bytea CHECK (manifest_digest IS NULL OR octet_length(manifest_digest) = 32),
    requested_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
    membership_policy text NOT NULL DEFAULT 'public' CHECK (membership_policy IN ('public', 'invite')),
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'discovering', 'ready', 'rejected')),
    discover_lease_id uuid,
    discover_started_at timestamptz,
    discover_attempts integer NOT NULL DEFAULT 0 CHECK (discover_attempts >= 0),
    error text,
    created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id)
);

CREATE INDEX subplatform_source_intakes_queue_idx
    ON subplatform_source_intakes (state, created_at ASC);

CREATE TRIGGER subplatform_source_intakes_updated_at
BEFORE UPDATE ON subplatform_source_intakes
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
