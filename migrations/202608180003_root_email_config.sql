-- Deployment-wide authentication mail is intentionally separate from child-platform
-- notification mail. It must be usable before a root organization or any domain exists.
-- The credential itself never enters this table: `credential_slot` resolves below the
-- web service's root-only secret directory.

CREATE TABLE root_email_config (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]{1,99}$'),
    smtp_host text NOT NULL CHECK (length(smtp_host) BETWEEN 1 AND 255),
    smtp_port integer NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
    tls_mode text NOT NULL CHECK (tls_mode IN ('starttls', 'tls', 'plain')),
    username text NOT NULL CHECK (length(username) BETWEEN 1 AND 320),
    credential_slot text NOT NULL CHECK (credential_slot ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    from_address text NOT NULL CHECK (length(from_address) BETWEEN 3 AND 320),
    reply_to text CHECK (reply_to IS NULL OR length(reply_to) BETWEEN 3 AND 320),
    mode text NOT NULL DEFAULT 'production' CHECK (mode IN ('test', 'production')),
    enabled boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by uuid NOT NULL REFERENCES "user"(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE root_email_config_audit (
    audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    config_version bigint NOT NULL CHECK (config_version > 0),
    actor_user_id uuid NOT NULL REFERENCES "user"(id),
    action text NOT NULL CHECK (action IN ('created', 'updated', 'tested')),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX root_email_config_audit_created_at_idx
    ON root_email_config_audit (created_at DESC);

CREATE TRIGGER root_email_config_updated_at
BEFORE UPDATE ON root_email_config
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
