-- Pin invoice-provider credential material for already-requested invoices. Existing production
-- rows remain nullable so upgrades are non-destructive; issuance rejects legacy rows until the
-- provider is re-saved/reconciled.

ALTER TABLE invoice_provider_configs
    ADD COLUMN credential_secret_digest bytea,
    ADD CONSTRAINT invoice_provider_credential_digest_check
        CHECK (credential_secret_digest IS NULL OR octet_length(credential_secret_digest) = 32);

ALTER TABLE invoice_requests
    ADD COLUMN provider_credential_digest bytea,
    ADD CONSTRAINT invoice_requests_provider_credential_digest_check
        CHECK (provider_credential_digest IS NULL OR octet_length(provider_credential_digest) = 32);

