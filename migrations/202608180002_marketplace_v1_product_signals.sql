-- Domain-neutral V1 product signals.
--
-- The root stores the durable interaction contract, not a vehicle schema.  A subplatform or
-- caller-funded Agent may put its own typed fields in profile/metadata JSON; the root only owns
-- scope, lifecycle, idempotency and privacy boundaries.

CREATE TABLE marketplace_intent_profiles (
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    profile jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(profile) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, domain_id, participant_id),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, participant_id) REFERENCES marketplace_parties(tenant_id, id)
);

CREATE INDEX marketplace_intent_profiles_updated_idx
    ON marketplace_intent_profiles (tenant_id, participant_id, updated_at DESC);

CREATE TABLE marketplace_behavior_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    intent_id uuid,
    offer_id uuid,
    event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
    reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, participant_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, intent_id) REFERENCES marketplace_intents(tenant_id, id),
    FOREIGN KEY (tenant_id, offer_id) REFERENCES marketplace_offers(tenant_id, id),
    UNIQUE (tenant_id, participant_id, idempotency_key)
);

CREATE INDEX marketplace_behavior_events_lookup_idx
    ON marketplace_behavior_events (tenant_id, domain_id, participant_id, occurred_at DESC);
CREATE INDEX marketplace_behavior_events_offer_idx
    ON marketplace_behavior_events (tenant_id, domain_id, offer_id, event_type, occurred_at DESC)
    WHERE offer_id IS NOT NULL;

CREATE TABLE marketplace_offer_preferences (
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('saved', 'dismissed', 'neutral')),
    reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, domain_id, participant_id, offer_id),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, participant_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, offer_id) REFERENCES marketplace_offers(tenant_id, id)
);

CREATE INDEX marketplace_offer_preferences_state_idx
    ON marketplace_offer_preferences (tenant_id, domain_id, participant_id, state, updated_at DESC);

CREATE TABLE marketplace_sales_handoffs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    intent_id uuid,
    summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
    status text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'assigned', 'accepted', 'closed', 'declined')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, participant_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, intent_id) REFERENCES marketplace_intents(tenant_id, id),
    UNIQUE (tenant_id, participant_id, idempotency_key)
);

CREATE INDEX marketplace_sales_handoffs_queue_idx
    ON marketplace_sales_handoffs (tenant_id, domain_id, status, created_at DESC);

CREATE TRIGGER marketplace_intent_profiles_updated_at
BEFORE UPDATE ON marketplace_intent_profiles FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TRIGGER marketplace_offer_preferences_updated_at
BEFORE UPDATE ON marketplace_offer_preferences FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TRIGGER marketplace_sales_handoffs_updated_at
BEFORE UPDATE ON marketplace_sales_handoffs FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
