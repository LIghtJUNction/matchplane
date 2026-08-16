-- Audit and consent events for domain-neutral introductions.
-- Contact values remain encrypted on marketplace_parties; this table stores only decisions and
-- non-secret request fingerprints so every release is explainable without exposing a channel.

CREATE TABLE marketplace_introduction_contact_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    introduction_id uuid NOT NULL,
    actor_party_id uuid NOT NULL,
    target_party_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('contact_requested', 'contact_consent', 'contact_release')),
    decision text NOT NULL CHECK (decision IN ('allowed', 'denied')),
    request_fingerprint bytea CHECK (request_fingerprint IS NULL OR octet_length(request_fingerprint) = 32),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, introduction_id) REFERENCES marketplace_introductions(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_party_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, target_party_id) REFERENCES marketplace_parties(tenant_id, id),
    CHECK (actor_party_id <> target_party_id)
);

CREATE INDEX marketplace_introduction_contact_events_time_idx
    ON marketplace_introduction_contact_events (tenant_id, introduction_id, occurred_at DESC);
