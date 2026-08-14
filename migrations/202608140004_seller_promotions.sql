-- Seller-funded promotion campaigns are the primary revenue path when a match leaves the
-- platform. Campaigns are domain-neutral: a target may be a vehicle listing today or another
-- supply-side offer in a future vertical.

CREATE TABLE seller_promotion_campaigns (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sponsor_party_id uuid NOT NULL,
    target_kind text NOT NULL CHECK (target_kind ~ '^[a-z][a-z0-9_./-]{0,63}$'),
    target_key text NOT NULL CHECK (length(target_key) BETWEEN 1 AND 256),
    policy text NOT NULL DEFAULT 'seller_promotion'
        CHECK (policy IN ('seller_promotion', 'hybrid')),
    pricing_model text NOT NULL CHECK (pricing_model IN ('fixed', 'cpm', 'cpc', 'cpl')),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    unit_price numeric(38, 0) NOT NULL CHECK (unit_price >= 0 AND scale(unit_price) = 0),
    budget_amount numeric(38, 0) NOT NULL CHECK (budget_amount > 0 AND scale(budget_amount) = 0),
    spent_amount numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (spent_amount >= 0 AND scale(spent_amount) = 0),
    billable_units bigint NOT NULL DEFAULT 0 CHECK (billable_units >= 0),
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'paused', 'exhausted', 'expired', 'cancelled')),
    starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ends_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, sponsor_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, id),
    CHECK (ends_at IS NULL OR ends_at > starts_at),
    CHECK (spent_amount <= budget_amount)
);

CREATE INDEX seller_promotion_campaign_lookup_idx
    ON seller_promotion_campaigns (tenant_id, target_kind, target_key, status, starts_at, ends_at);

CREATE TABLE seller_promotion_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    actor_party_id uuid,
    event_type text NOT NULL CHECK (event_type IN
        ('impression', 'click', 'qualified_lead', 'contact_exchange')),
    billable_units bigint NOT NULL CHECK (billable_units >= 0),
    charged_amount numeric(38, 0) NOT NULL CHECK (charged_amount >= 0 AND scale(charged_amount) = 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 18),
    deduplication_key text NOT NULL CHECK (length(deduplication_key) BETWEEN 1 AND 240),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES seller_promotion_campaigns(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_party_id) REFERENCES marketplace_parties(tenant_id, id),
    UNIQUE (tenant_id, campaign_id, deduplication_key)
);

CREATE INDEX seller_promotion_events_campaign_time_idx
    ON seller_promotion_events (tenant_id, campaign_id, occurred_at DESC);

CREATE TRIGGER seller_promotion_campaigns_updated_at
BEFORE UPDATE ON seller_promotion_campaigns
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
