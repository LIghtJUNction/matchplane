-- Upgrade the original currency settings table without rewriting migration 202608280001.
-- Existing rate snapshots predate provider dates and response digests. Because their source
-- response cannot be reconstructed honestly, discard only the re-syncable snapshot fields while
-- preserving each tenant's local currency selection and optimistic-lock version.
LOCK TABLE mall_currency_settings IN ACCESS EXCLUSIVE MODE;

ALTER TABLE mall_currency_settings
    ADD COLUMN rate_provider text,
    ADD COLUMN rate_effective_date date,
    ADD COLUMN rate_response_digest text;

UPDATE mall_currency_settings
   SET usd_to_local_rate = NULL,
       rate_source = NULL,
       rate_provider = NULL,
       rate_effective_date = NULL,
       rate_response_digest = NULL,
       rate_updated_at = NULL
 WHERE usd_to_local_rate IS NOT NULL
    OR rate_source IS NOT NULL
    OR rate_updated_at IS NOT NULL;

-- Unbounded numeric retains provider decimal lexemes exactly instead of rounding future snapshots
-- to the scale imposed by the original numeric(30, 12) column.
ALTER TABLE mall_currency_settings
    ALTER COLUMN usd_to_local_rate TYPE numeric
    USING usd_to_local_rate::numeric;

-- Migration 202608280001 let PostgreSQL name its CHECK constraints. Discover and remove every
-- legacy table CHECK by catalog identity so the upgrade works regardless of generated names.
DO $migration$
DECLARE
    legacy_constraint record;
BEGIN
    FOR legacy_constraint IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'mall_currency_settings'::regclass
           AND contype = 'c'
    LOOP
        EXECUTE format(
            'ALTER TABLE mall_currency_settings DROP CONSTRAINT %I',
            legacy_constraint.conname
        );
    END LOOP;
END
$migration$;

-- Normalize the names of the original automatically named key constraints without rebuilding
-- them or weakening tenant ownership during the migration.
DO $migration$
DECLARE
    actual_name name;
BEGIN
    SELECT conname
      INTO actual_name
      FROM pg_constraint
     WHERE conrelid = 'mall_currency_settings'::regclass
       AND contype = 'p';
    IF actual_name IS NULL THEN
        RAISE EXCEPTION 'mall_currency_settings primary key is missing';
    ELSIF actual_name <> 'mall_currency_settings_pkey' THEN
        EXECUTE format(
            'ALTER TABLE mall_currency_settings RENAME CONSTRAINT %I TO mall_currency_settings_pkey',
            actual_name
        );
    END IF;

    SELECT conname
      INTO actual_name
      FROM pg_constraint
     WHERE conrelid = 'mall_currency_settings'::regclass
       AND confrelid = 'tenants'::regclass
       AND contype = 'f';
    IF actual_name IS NULL THEN
        RAISE EXCEPTION 'mall_currency_settings tenant foreign key is missing';
    ELSIF actual_name <> 'mall_currency_settings_tenant_id_fkey' THEN
        EXECUTE format(
            'ALTER TABLE mall_currency_settings RENAME CONSTRAINT %I TO mall_currency_settings_tenant_id_fkey',
            actual_name
        );
    END IF;
END
$migration$;

ALTER TABLE mall_currency_settings
    ADD CONSTRAINT mall_currency_settings_local_currency_check
        CHECK (local_currency ~ '^[A-Z]{3}$') NOT VALID,
    ADD CONSTRAINT mall_currency_settings_rate_range_check
        CHECK (
            usd_to_local_rate IS NULL
            OR (usd_to_local_rate > 0 AND usd_to_local_rate <= 1000000000000)
        ) NOT VALID,
    ADD CONSTRAINT mall_currency_settings_rate_source_check
        CHECK (rate_source IS NULL OR length(rate_source) BETWEEN 1 AND 255) NOT VALID,
    ADD CONSTRAINT mall_currency_settings_rate_provider_check
        CHECK (rate_provider IS NULL OR length(rate_provider) BETWEEN 1 AND 128) NOT VALID,
    ADD CONSTRAINT mall_currency_settings_rate_response_digest_check
        CHECK (
            rate_response_digest IS NULL
            OR rate_response_digest ~ '^sha256:[0-9a-f]{64}$'
        ) NOT VALID,
    ADD CONSTRAINT mall_currency_settings_version_check
        CHECK (version > 0) NOT VALID,
    ADD CONSTRAINT mall_currency_settings_snapshot_coherence_check
        CHECK (
            (
                usd_to_local_rate IS NULL
                AND rate_source IS NULL
                AND rate_provider IS NULL
                AND rate_effective_date IS NULL
                AND rate_response_digest IS NULL
                AND rate_updated_at IS NULL
            )
            OR
            (
                usd_to_local_rate IS NOT NULL
                AND rate_source IS NOT NULL
                AND rate_provider IS NOT NULL
                AND rate_effective_date IS NOT NULL
                AND rate_response_digest IS NOT NULL
                AND rate_updated_at IS NOT NULL
            )
        ) NOT VALID;

ALTER TABLE mall_currency_settings
    VALIDATE CONSTRAINT mall_currency_settings_local_currency_check,
    VALIDATE CONSTRAINT mall_currency_settings_rate_range_check,
    VALIDATE CONSTRAINT mall_currency_settings_rate_source_check,
    VALIDATE CONSTRAINT mall_currency_settings_rate_provider_check,
    VALIDATE CONSTRAINT mall_currency_settings_rate_response_digest_check,
    VALIDATE CONSTRAINT mall_currency_settings_version_check,
    VALIDATE CONSTRAINT mall_currency_settings_snapshot_coherence_check;

CREATE INDEX mall_currency_settings_provider_effective_date_idx
    ON mall_currency_settings (rate_provider, rate_effective_date DESC)
    WHERE usd_to_local_rate IS NOT NULL;
