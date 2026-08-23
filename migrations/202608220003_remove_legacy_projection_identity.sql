-- Phase two of the rolling destination deployment: every writer now keys idempotency by the
-- immutable active registration. Remove the temporary version-only arbiter so the same canonical
-- offer version can be replayed into a newly activated child release.

DO $migration$
DECLARE
  previous_constraint text;
BEGIN
  SELECT constraint_row.conname
    INTO previous_constraint
    FROM pg_constraint constraint_row
   WHERE constraint_row.conrelid = 'marketplace_offer_projection_jobs'::regclass
     AND constraint_row.contype = 'u'
     AND pg_get_constraintdef(constraint_row.oid) =
         'UNIQUE (tenant_id, offer_id, canonical_version)'
   LIMIT 1;
  IF previous_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE marketplace_offer_projection_jobs DROP CONSTRAINT %I',
      previous_constraint
    );
  END IF;
END
$migration$;

UPDATE marketplace_offer_projection_jobs
   SET status = 'dead',
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error_code = 'destination_unavailable',
       last_error = 'catalog projection has no immutable active registration destination',
       updated_at = clock_timestamp()
 WHERE registration_id IS NULL
   AND status IN ('pending', 'retry');
