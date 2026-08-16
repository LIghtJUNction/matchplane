-- Keep payment/invoice contracts domain-neutral. Existing vehicle_* values remain readable as
-- compatibility data, while new requests use the generic sale purpose/kind or a subplatform-owned
-- purpose label.

ALTER TABLE payment_intents
    DROP CONSTRAINT IF EXISTS payment_intents_purpose_check;

ALTER TABLE payment_intents
    ADD CONSTRAINT payment_intents_purpose_check
    CHECK (purpose ~ '^[a-z][a-z0-9_.:-]{0,99}$');

ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_kind_check;

ALTER TABLE invoice_requests
    ADD CONSTRAINT invoice_requests_kind_check
    CHECK (kind IN ('sale', 'vehicle_sale', 'platform_commission'));
