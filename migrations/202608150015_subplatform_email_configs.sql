-- Each subplatform may route login/notification mail through its own SMTP provider.
-- Credentials are references resolved by the deployment secret manager; plaintext secrets
-- never enter the manifest, browser, database, or API response.

CREATE TABLE subplatform_email_configs (
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]{1,99}$'),
    smtp_host text NOT NULL CHECK (length(smtp_host) BETWEEN 1 AND 255),
    smtp_port integer NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
    tls_mode text NOT NULL CHECK (tls_mode IN ('starttls', 'tls', 'plain')),
    username text NOT NULL CHECK (length(username) BETWEEN 1 AND 320),
    credential_secret_ref text NOT NULL CHECK (length(credential_secret_ref) BETWEEN 5 AND 2048),
    from_address text NOT NULL CHECK (length(from_address) BETWEEN 3 AND 320),
    reply_to text CHECK (reply_to IS NULL OR length(reply_to) BETWEEN 3 AND 320),
    mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'production')),
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, domain_id),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id)
);

CREATE INDEX subplatform_email_configs_enabled_idx
    ON subplatform_email_configs (tenant_id, enabled, mode);

CREATE TRIGGER subplatform_email_configs_updated_at
BEFORE UPDATE ON subplatform_email_configs
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
