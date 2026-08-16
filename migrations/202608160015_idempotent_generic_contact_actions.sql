-- Contact transitions are write operations. Keep retries safe and auditable without
-- duplicating consent/release events.

ALTER TABLE marketplace_introduction_contact_events
    ADD COLUMN idempotency_key text;

UPDATE marketplace_introduction_contact_events
   SET idempotency_key = 'legacy-' || id::text
 WHERE idempotency_key IS NULL;

ALTER TABLE marketplace_introduction_contact_events
    ALTER COLUMN idempotency_key SET NOT NULL,
    ADD CONSTRAINT marketplace_contact_events_idempotency_key_check
        CHECK (length(idempotency_key) BETWEEN 1 AND 240);

CREATE UNIQUE INDEX marketplace_contact_events_idempotency_idx
    ON marketplace_introduction_contact_events
       (tenant_id, introduction_id, actor_party_id, event_type, idempotency_key);
