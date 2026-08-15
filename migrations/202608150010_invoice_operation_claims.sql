ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_status_check;

-- The original table definition used an anonymous check constraint name for
-- correction states. Drop it as well as the explicitly named replacement
-- below; otherwise red-letter processing can never enter its durable
-- `red_lettering` claim state on databases created before this migration.
ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_check1;

ALTER TABLE invoice_requests
    ADD CONSTRAINT invoice_requests_status_check
    CHECK (status IN ('requested', 'reviewing', 'issuing', 'issued', 'failed', 'voiding', 'voided',
        'red_letter_pending', 'red_lettering', 'red_lettered'));

ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_correction_of_invoice_id_check;

ALTER TABLE invoice_requests
    ADD CONSTRAINT invoice_requests_correction_of_invoice_id_check
    CHECK (correction_of_invoice_id IS NULL OR status IN ('red_letter_pending', 'red_lettering', 'red_lettered'));
