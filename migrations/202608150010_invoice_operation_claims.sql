ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_status_check;

ALTER TABLE invoice_requests
    ADD CONSTRAINT invoice_requests_status_check
    CHECK (status IN ('requested', 'reviewing', 'issuing', 'issued', 'failed', 'voiding', 'voided',
        'red_letter_pending', 'red_lettering', 'red_lettered'));

ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_correction_of_invoice_id_check;

ALTER TABLE invoice_requests
    ADD CONSTRAINT invoice_requests_correction_of_invoice_id_check
    CHECK (correction_of_invoice_id IS NULL OR status IN ('red_letter_pending', 'red_lettering', 'red_lettered'));
