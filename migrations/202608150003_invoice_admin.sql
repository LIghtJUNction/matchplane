-- Keep invoice-provider onboarding and mode changes auditable and versioned just like
-- payment-gateway changes. Secrets remain outside PostgreSQL; these tables only record
-- the non-secret reference and configuration metadata.

CREATE TABLE invoice_mode_audit (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    old_mode text NOT NULL CHECK (old_mode IN ('test', 'production')),
    new_mode text NOT NULL CHECK (new_mode IN ('test', 'production')),
    old_provider_id uuid NOT NULL,
    new_provider_id uuid NOT NULL,
    old_version bigint NOT NULL CHECK (old_version > 0),
    new_version bigint NOT NULL CHECK (new_version > 0),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, old_provider_id)
        REFERENCES invoice_provider_configs(tenant_id, id),
    FOREIGN KEY (tenant_id, new_provider_id)
        REFERENCES invoice_provider_configs(tenant_id, id),
    CHECK (old_mode <> new_mode OR old_provider_id <> new_provider_id)
);

CREATE INDEX invoice_mode_audit_tenant_time_idx
    ON invoice_mode_audit (tenant_id, occurred_at DESC);

CREATE TABLE invoice_config_audit (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
    action text NOT NULL CHECK (action IN ('provider_created', 'provider_updated')),
    target_id uuid NOT NULL,
    before_value jsonb,
    after_value jsonb NOT NULL CHECK (jsonb_typeof(after_value) = 'object'),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (before_value IS NULL OR jsonb_typeof(before_value) = 'object')
);

CREATE INDEX invoice_config_audit_tenant_time_idx
    ON invoice_config_audit (tenant_id, occurred_at DESC);
