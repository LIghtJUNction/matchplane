-- Identify the worker that owns a processing claim. A stale worker must not be able to finish
-- an event after a later retry has reclaimed it.

ALTER TABLE payment_webhook_inbox
    ADD COLUMN processing_token uuid;

