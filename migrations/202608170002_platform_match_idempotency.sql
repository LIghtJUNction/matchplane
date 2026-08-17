-- A caller-supplied key makes retries of the platform routing boundary safe.
-- The unique scope is the authenticated actor plus the canonical node path; the
-- same key may therefore be reused independently by a buyer Agent and a seller
-- Agent, or by two different mounted platform nodes.
ALTER TABLE platform_match_requests
    ADD COLUMN IF NOT EXISTS idempotency_key text
        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 240);

CREATE UNIQUE INDEX IF NOT EXISTS platform_match_requests_idempotency_idx
    ON platform_match_requests (auth_user_id, platform_path, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
