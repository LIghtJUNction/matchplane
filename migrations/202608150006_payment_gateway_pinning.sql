-- Payment operations must continue against the exact gateway configuration selected when the
-- payment was created. The revision and credential reference are intentionally persisted on the
-- intent so retries cannot silently pick up a later merchant identity or rotated secret.

ALTER TABLE payment_intents
    ADD COLUMN gateway_config_version bigint,
    ADD COLUMN gateway_credential_secret_ref text;

UPDATE payment_intents AS p
SET gateway_config_version = g.version,
    gateway_credential_secret_ref = g.credential_secret_ref
FROM payment_gateway_configs AS g
WHERE g.tenant_id = p.tenant_id
  AND g.id = p.gateway_id;

ALTER TABLE payment_intents
    ALTER COLUMN gateway_config_version SET NOT NULL,
    ADD CONSTRAINT payment_intents_gateway_config_version_check
        CHECK (gateway_config_version > 0),
    ADD CONSTRAINT payment_intents_gateway_credential_ref_check
        CHECK ((gateway_mode = 'test' AND gateway_credential_secret_ref IS NULL)
            OR (gateway_mode = 'production'
                AND gateway_credential_secret_ref IS NOT NULL
                AND length(gateway_credential_secret_ref) BETWEEN 5 AND 2048));

CREATE INDEX payment_intents_gateway_revision_idx
    ON payment_intents (gateway_id, gateway_config_version);
