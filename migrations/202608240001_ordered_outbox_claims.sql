-- Preserve per-key Kafka ordering when multiple relay replicas claim the transactional outbox.
-- The token fences acknowledgements from a relay whose stale claim was reclaimed.

ALTER TABLE outbox_events
    ADD COLUMN claim_token uuid;

CREATE INDEX outbox_unpublished_key_sequence_idx
    ON outbox_events (topic, message_key, shard_sequence, created_at, event_id)
    WHERE status <> 'published';

CREATE INDEX outbox_stale_publishing_idx
    ON outbox_events (claimed_at)
    WHERE status = 'publishing';

COMMENT ON COLUMN outbox_events.claim_token IS
    'Fences completion of a publishing claim after stale-claim recovery';
