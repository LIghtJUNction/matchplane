-- Provider callbacks need indexed order lookup and a durable retention boundary.

CREATE INDEX payment_intents_gateway_provider_reference_idx
    ON payment_intents (gateway_id, provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE INDEX payment_refunds_provider_reference_idx
    ON payment_refunds (provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE INDEX payment_webhook_inbox_received_idx
    ON payment_webhook_inbox (received_at)
    WHERE status IN ('received', 'failed');
