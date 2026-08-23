-- Explicit, tenant-scoped shopping memory for signed-in customers.
-- Assistant inference never writes this table; only the authenticated self-service route may do so.
CREATE TABLE IF NOT EXISTS shopping_memory_profiles (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    auth_user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    facts jsonb NOT NULL DEFAULT '[]'::jsonb,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, auth_user_id),
    CONSTRAINT shopping_memory_profiles_facts_array
        CHECK (jsonb_typeof(facts) = 'array'),
    CONSTRAINT shopping_memory_profiles_facts_limit
        CHECK (jsonb_array_length(facts) <= 16),
    CONSTRAINT shopping_memory_profiles_facts_size
        CHECK (octet_length(facts::text) <= 8192)
);

CREATE INDEX IF NOT EXISTS shopping_memory_profiles_user_idx
    ON shopping_memory_profiles (auth_user_id, tenant_id);

COMMENT ON TABLE shopping_memory_profiles IS
    'Customer-authored, opt-in shopping defaults. Model inference is not persisted here.';
COMMENT ON COLUMN shopping_memory_profiles.enabled IS
    'Consent switch; facts are ignored by the shopping Agent unless true.';
COMMENT ON COLUMN shopping_memory_profiles.facts IS
    'Bounded array of validated budget, purpose, preference, or exclusion facts.';
