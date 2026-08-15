-- Domain-neutral marketplace primitives.
--
-- Vertical packages own the meaning of attributes/terms.  The root only stores the bounded
-- narrative, canonical references, participant identity and the auditable introduction state.
-- Automotive tables remain compatibility adapters; new verticals must use these tables instead.

CREATE TABLE marketplace_intents (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    side text NOT NULL CHECK (side IN ('demand', 'supply')),
    narrative text NOT NULL CHECK (length(narrative) BETWEEN 1 AND 10000),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(attributes) = 'object'),
    terms jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(terms) = 'object'),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'matched', 'closed', 'expired')),
    expires_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, participant_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, participant_id, idempotency_key)
);

CREATE INDEX marketplace_intents_active_idx
    ON marketplace_intents (tenant_id, domain_id, side, status, created_at DESC);

CREATE TABLE marketplace_offers (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    supply_party_id uuid NOT NULL,
    asset_id uuid,
    external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 256),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 500),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(attributes) = 'object'),
    terms jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(terms) = 'object'),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'reserved', 'sold', 'withdrawn', 'expired')),
    published_at timestamptz,
    expires_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, supply_party_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, domain_id, asset_id)
        REFERENCES assets(tenant_id, domain_id, id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, domain_id, external_key),
    CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at)
);

CREATE INDEX marketplace_offers_active_idx
    ON marketplace_offers (tenant_id, domain_id, status, published_at DESC);

CREATE TABLE marketplace_introductions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    demand_intent_id uuid NOT NULL,
    supply_offer_id uuid NOT NULL,
    demand_party_id uuid NOT NULL,
    supply_party_id uuid NOT NULL,
    score double precision NOT NULL CHECK (score BETWEEN 0 AND 1),
    reasons jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(reasons) = 'array'),
    status text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'contact_requested', 'contact_released',
            'declined', 'expired', 'completed', 'disputed')),
    supply_contact_consent_at timestamptz,
    contact_released_at timestamptz,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
    expires_at timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, demand_intent_id) REFERENCES marketplace_intents(tenant_id, id),
    FOREIGN KEY (tenant_id, supply_offer_id) REFERENCES marketplace_offers(tenant_id, id),
    FOREIGN KEY (tenant_id, demand_party_id) REFERENCES marketplace_parties(tenant_id, id),
    FOREIGN KEY (tenant_id, supply_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, demand_intent_id, supply_offer_id),
    UNIQUE (tenant_id, demand_party_id, idempotency_key),
    CHECK (demand_party_id <> supply_party_id),
    CHECK ((status = 'proposed' AND supply_contact_consent_at IS NULL
            AND contact_released_at IS NULL)
        OR status <> 'proposed'),
    CHECK (contact_released_at IS NULL OR supply_contact_consent_at IS NOT NULL)
);

CREATE INDEX marketplace_introductions_party_idx
    ON marketplace_introductions (tenant_id, demand_party_id, supply_party_id, status, created_at DESC);

CREATE TRIGGER marketplace_intents_updated_at
BEFORE UPDATE ON marketplace_intents FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TRIGGER marketplace_offers_updated_at
BEFORE UPDATE ON marketplace_offers FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TRIGGER marketplace_introductions_updated_at
BEFORE UPDATE ON marketplace_introductions FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
