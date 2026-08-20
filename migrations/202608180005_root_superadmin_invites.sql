-- A single CLI-issued bootstrap link creates the first root super administrator without SMTP.
CREATE TABLE root_superadmin_invites (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    target_email text CHECK (target_email IS NULL OR length(target_email) BETWEEN 3 AND 320),
    registration_email text CHECK (registration_email IS NULL OR length(registration_email) BETWEEN 3 AND 320),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    used_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (used_at IS NULL OR used_by IS NOT NULL)
);
