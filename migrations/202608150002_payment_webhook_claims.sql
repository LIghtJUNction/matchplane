-- Claim webhook inbox rows before applying provider state changes so concurrent
-- deliveries cannot execute the same event twice. A stale processing claim is
-- retryable after a process crash.

ALTER TABLE payment_webhook_inbox
    DROP CONSTRAINT payment_webhook_inbox_status_check,
    ADD CONSTRAINT payment_webhook_inbox_status_check
        CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed'));

ALTER TABLE payment_webhook_inbox
    ADD COLUMN processing_at timestamptz,
    ADD CONSTRAINT payment_webhook_inbox_processing_at_check
        CHECK ((status = 'processing') = (processing_at IS NOT NULL));

CREATE INDEX payment_webhook_inbox_processing_idx
    ON payment_webhook_inbox (processing_at)
    WHERE status = 'processing';
