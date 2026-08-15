-- Pin the resolved credential material, not only the operator-controlled reference alias.
-- Existing production rows remain nullable so this migration is non-destructive; the payment
-- service rejects legacy rows without a digest until an administrator re-saves/reconciles them.

ALTER TABLE payment_gateway_configs
    ADD COLUMN credential_secret_digest bytea,
    ADD CONSTRAINT payment_gateway_credential_digest_check
        CHECK (credential_secret_digest IS NULL OR octet_length(credential_secret_digest) = 32);

ALTER TABLE payment_intents
    ADD COLUMN gateway_credential_digest bytea,
    ADD CONSTRAINT payment_intents_gateway_credential_digest_check
        CHECK (gateway_credential_digest IS NULL OR octet_length(gateway_credential_digest) = 32);

