-- Tenant-scoped currency preferences and the latest USD conversion snapshot.
-- Rates are refreshed explicitly by a marketplace owner; they are never treated as
-- payment authorization or as a replacement for the currency on a product offer.
CREATE TABLE IF NOT EXISTS mall_currency_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    local_currency text NOT NULL DEFAULT 'CNY'
        CONSTRAINT mall_currency_settings_local_currency_check
        CHECK (local_currency ~ '^[A-Z]{3}$'),
    -- PostgreSQL numeric is intentionally unbounded here: the provider decimal lexeme is
    -- persisted exactly instead of being rounded to a fixed scale or passing through float.
    usd_to_local_rate numeric
        CONSTRAINT mall_currency_settings_rate_range_check
        CHECK (
            usd_to_local_rate IS NULL
            OR (usd_to_local_rate > 0 AND usd_to_local_rate <= 1000000000000)
        ),
    rate_source text
        CONSTRAINT mall_currency_settings_rate_source_check
        CHECK (rate_source IS NULL OR length(rate_source) BETWEEN 1 AND 255),
    rate_provider text
        CONSTRAINT mall_currency_settings_rate_provider_check
        CHECK (rate_provider IS NULL OR length(rate_provider) BETWEEN 1 AND 128),
    rate_effective_date date,
    rate_response_digest text
        CONSTRAINT mall_currency_settings_rate_response_digest_check
        CHECK (
            rate_response_digest IS NULL
            OR rate_response_digest ~ '^sha256:[0-9a-f]{64}$'
        ),
    rate_updated_at timestamptz,
    version bigint NOT NULL DEFAULT 1
        CONSTRAINT mall_currency_settings_version_check CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT mall_currency_settings_snapshot_coherence_check CHECK (
        (
            usd_to_local_rate IS NULL
            AND rate_source IS NULL
            AND rate_provider IS NULL
            AND rate_effective_date IS NULL
            AND rate_response_digest IS NULL
            AND rate_updated_at IS NULL
        )
        OR
        (
            usd_to_local_rate IS NOT NULL
            AND rate_source IS NOT NULL
            AND rate_provider IS NOT NULL
            AND rate_effective_date IS NOT NULL
            AND rate_response_digest IS NOT NULL
            AND rate_updated_at IS NOT NULL
        )
    )
);

CREATE INDEX IF NOT EXISTS mall_currency_settings_updated_at_idx
    ON mall_currency_settings (updated_at DESC);

CREATE INDEX IF NOT EXISTS mall_currency_settings_provider_effective_date_idx
    ON mall_currency_settings (rate_provider, rate_effective_date DESC)
    WHERE usd_to_local_rate IS NOT NULL;
