-- Explicit, contact-free demand discovery for supply-side Agents.
--
-- A demand participant may opt into having a bounded summary ranked by supply Agents.  This is
-- separate from contact consent: no contact value, participant identity, or introduction is
-- exposed by the discovery query.

ALTER TABLE marketplace_intents
    ADD COLUMN supply_discovery_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN supply_discovery_expires_at timestamptz;

ALTER TABLE marketplace_intents
    ADD CONSTRAINT marketplace_intents_supply_discovery_expiry_check
    CHECK (supply_discovery_expires_at IS NULL OR supply_discovery_enabled);

ALTER TABLE marketplace_intents
    ADD CONSTRAINT marketplace_intents_supply_discovery_side_check
    CHECK (NOT supply_discovery_enabled OR side = 'demand');

CREATE INDEX marketplace_intents_supply_discovery_idx
    ON marketplace_intents (tenant_id, domain_id, status, created_at DESC)
    WHERE side = 'demand' AND supply_discovery_enabled = true;
