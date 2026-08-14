-- Explicit seller consent for exchanging phone/WeChat contact details.

ALTER TABLE offline_deals
    ADD COLUMN seller_contact_consent_at timestamptz;

CREATE INDEX offline_deals_contact_consent_idx
    ON offline_deals (tenant_id, seller_party_id, seller_contact_consent_at)
    WHERE seller_contact_consent_at IS NOT NULL;

-- The bundled demo market exercises contact exchange independently of payment. Production
-- tenants choose their own revenue policy through the market configuration.
UPDATE markets
SET settlement_mode = 'offline_direct',
    offline_commission_collection = 'postpaid'
WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'matchplane-demo')
  AND domain_id IN (SELECT id FROM domains WHERE tenant_id = markets.tenant_id AND slug = 'automotive');
