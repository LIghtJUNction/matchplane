-- Generic payment and invoice source references.
--
-- A source is an opaque, tenant-owned reference supplied by the mounted platform.  The root
-- payment service routes money and refunds without assuming that the source is a vehicle, deal,
-- order, booking, or any other vertical object.  The old offline_deal_id columns remain as an
-- explicit compatibility adapter for historical vehicle deployments.
ALTER TABLE payment_intents
    ADD COLUMN source_type text,
    ADD COLUMN source_ref text,
    ADD CONSTRAINT payment_intents_source_type_check
        CHECK (source_type IS NULL OR source_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
    ADD CONSTRAINT payment_intents_source_ref_check
        CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 256),
    ADD CONSTRAINT payment_intents_source_pair_check
        CHECK ((source_type IS NULL AND source_ref IS NULL)
            OR (source_type IS NOT NULL AND source_ref IS NOT NULL));

CREATE INDEX payment_intents_source_idx
    ON payment_intents (tenant_id, source_type, source_ref)
    WHERE source_type IS NOT NULL;

ALTER TABLE invoice_requests
    ADD COLUMN source_type text,
    ADD COLUMN source_ref text,
    DROP CONSTRAINT IF EXISTS invoice_requests_kind_check,
    DROP CONSTRAINT IF EXISTS invoice_requests_check,
    ADD CONSTRAINT invoice_requests_kind_check
        CHECK (kind ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
    ADD CONSTRAINT invoice_requests_source_type_check
        CHECK (source_type IS NULL OR source_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
    ADD CONSTRAINT invoice_requests_source_ref_check
        CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 256),
    ADD CONSTRAINT invoice_requests_source_pair_check
        CHECK ((source_type IS NULL AND source_ref IS NULL)
            OR (source_type IS NOT NULL AND source_ref IS NOT NULL)),
    ADD CONSTRAINT invoice_requests_source_check
        CHECK (
            (kind = 'platform_commission' AND payment_id IS NOT NULL)
            OR (kind <> 'platform_commission'
                AND (payment_id IS NOT NULL OR offline_deal_id IS NOT NULL
                     OR source_ref IS NOT NULL))
        );

CREATE INDEX invoice_requests_source_idx
    ON invoice_requests (tenant_id, source_type, source_ref)
    WHERE source_type IS NOT NULL;

CREATE UNIQUE INDEX invoice_requests_generic_source_unique
    ON invoice_requests (tenant_id, source_type, source_ref, kind)
    WHERE correction_of_invoice_id IS NULL
      AND source_type IS NOT NULL
      AND source_ref IS NOT NULL
      AND status NOT IN ('failed', 'voided');
