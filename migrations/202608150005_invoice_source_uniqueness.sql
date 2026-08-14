-- One ordinary invoice may consume one economic source. Corrections are separate documents
-- linked through correction_of_invoice_id and intentionally excluded from these reservations.
-- Fail closed if historical data already contains ambiguous source duplicates; operators must
-- reconcile those documents before enabling this invariant.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM invoice_requests
        WHERE correction_of_invoice_id IS NULL
          AND status NOT IN ('failed', 'voided')
          AND payment_id IS NOT NULL
        GROUP BY tenant_id, payment_id, kind
        HAVING count(*) > 1
    ) OR EXISTS (
        SELECT 1
        FROM invoice_requests
        WHERE correction_of_invoice_id IS NULL
          AND status NOT IN ('failed', 'voided')
          AND offline_deal_id IS NOT NULL
        GROUP BY tenant_id, offline_deal_id, kind
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'invoice source duplicates must be reconciled before applying 202608150005';
    END IF;
END
$$;

CREATE UNIQUE INDEX invoice_requests_payment_source_unique
    ON invoice_requests (tenant_id, payment_id, kind)
    WHERE correction_of_invoice_id IS NULL
      AND payment_id IS NOT NULL
      AND status NOT IN ('failed', 'voided');

CREATE UNIQUE INDEX invoice_requests_offline_deal_source_unique
    ON invoice_requests (tenant_id, offline_deal_id, kind)
    WHERE correction_of_invoice_id IS NULL
      AND offline_deal_id IS NOT NULL
      AND status NOT IN ('failed', 'voided');
