-- One-time administrator registration links issued by the operator CLI.
-- Only a SHA-256 digest is stored; the raw token exists solely in the printed URL.
CREATE TABLE platform_admin_invites (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    organization_id uuid NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('rootAdmin', 'subplatform_admin')),
    created_by text NOT NULL DEFAULT 'cli' CHECK (length(created_by) BETWEEN 1 AND 200),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    used_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX platform_admin_invites_active_idx
    ON platform_admin_invites (organization_id, expires_at)
    WHERE used_at IS NULL;

CREATE INDEX platform_admin_invites_token_hash_idx
    ON platform_admin_invites (token_hash);
