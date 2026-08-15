-- Marketplace bearer capabilities are deliberately short-lived. A Better Auth session or
-- organization API key must mint a fresh capability after this deadline; a leaked token cannot
-- remain a permanent tenant credential.
ALTER TABLE marketplace_parties
    ADD COLUMN access_token_expires_at timestamptz NOT NULL
        DEFAULT (CURRENT_TIMESTAMP + INTERVAL '15 minutes');

ALTER TABLE marketplace_parties
    ADD CONSTRAINT marketplace_parties_access_token_expiry_check
        CHECK (access_token_expires_at > created_at);

CREATE INDEX marketplace_parties_active_token_expiry_idx
    ON marketplace_parties (tenant_id, id, access_token_expires_at)
    WHERE status = 'active';
