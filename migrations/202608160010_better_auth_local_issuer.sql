-- Better Auth's local account issuer is namespaced, for example
-- `local:credential`. Migration 008 preserved the pre-1.7 provider id verbatim,
-- which makes the sign-in adapter reject every existing credential account as
-- if it did not exist. Repair only the built-in credential namespace here; this
-- migration is idempotent and safe for fresh and already-migrated deployments.
UPDATE "account"
SET "issuer" = 'local:credential'
WHERE "providerId" = 'credential'
  AND "issuer" <> 'local:credential';
