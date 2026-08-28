-- Tenant-scoped currency preferences and the latest USD conversion snapshot.
-- Rates are refreshed explicitly by a marketplace owner; they are never treated as
-- payment authorization or as a replacement for the currency on a product offer.
CREATE TABLE IF NOT EXISTS mall_currency_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    local_currency text NOT NULL DEFAULT 'CNY'
        CHECK (local_currency ~ '^[A-Z]{3}$'),
    usd_to_local_rate numeric(30, 12)
        CHECK (usd_to_local_rate IS NULL OR usd_to_local_rate > 0),
    rate_source text,
    rate_updated_at timestamptz,
    version bigint NOT NULL DEFAULT 1
        CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS mall_currency_settings_updated_at_idx
    ON mall_currency_settings (updated_at DESC);
