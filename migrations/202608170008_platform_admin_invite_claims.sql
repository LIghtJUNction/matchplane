-- Reserve a one-time administrator invite before touching Better Auth's separate adapter.
-- A short lease closes the crash window between role application and used_at while still
-- allowing the same verified account to retry after a transient failure.
ALTER TABLE platform_admin_invites
    ADD COLUMN claimed_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
    ADD COLUMN claimed_at timestamptz,
    ADD COLUMN claim_expires_at timestamptz;

CREATE INDEX platform_admin_invites_claim_idx
    ON platform_admin_invites (id, claim_expires_at)
    WHERE used_at IS NULL AND claimed_by IS NOT NULL;
