CREATE TABLE kafka_consumer_quarantine (
    id uuid PRIMARY KEY,
    consumer_name text NOT NULL CHECK (length(consumer_name) BETWEEN 1 AND 128),
    source_topic text NOT NULL CHECK (length(source_topic) BETWEEN 1 AND 249),
    source_partition integer NOT NULL CHECK (source_partition >= 0),
    source_offset bigint NOT NULL CHECK (source_offset >= 0),
    message_key bytea CHECK (message_key IS NULL OR octet_length(message_key) <= 1024),
    message_key_present boolean NOT NULL,
    message_key_truncated boolean NOT NULL,
    message_key_sha256 bytea NOT NULL CHECK (octet_length(message_key_sha256) = 32),
    payload bytea CHECK (payload IS NULL OR octet_length(payload) <= 65536),
    payload_present boolean NOT NULL,
    payload_truncated boolean NOT NULL,
    payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
    failure_class text NOT NULL CHECK (
        failure_class IN ('invalid_payload', 'protocol_violation', 'processing_invariant')
    ),
    error_message text NOT NULL CHECK (length(error_message) BETWEEN 1 AND 2000),
    disposition text NOT NULL DEFAULT 'blocked' CHECK (
        disposition IN ('blocked', 'reconciled', 'discarded_non_authoritative')
    ),
    sightings integer NOT NULL DEFAULT 1 CHECK (sightings > 0),
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    resolved_at timestamptz,
    expires_at timestamptz,
    UNIQUE (consumer_name, source_topic, source_partition, source_offset),
    CHECK (
        (disposition = 'blocked' AND resolved_at IS NULL AND expires_at IS NULL)
        OR (disposition <> 'blocked' AND resolved_at IS NOT NULL AND expires_at IS NOT NULL)
    )
);

CREATE INDEX kafka_consumer_quarantine_blocked_idx
    ON kafka_consumer_quarantine (consumer_name, first_seen_at)
    WHERE disposition = 'blocked';

CREATE INDEX kafka_consumer_quarantine_retention_idx
    ON kafka_consumer_quarantine (expires_at)
    WHERE resolved_at IS NOT NULL;
