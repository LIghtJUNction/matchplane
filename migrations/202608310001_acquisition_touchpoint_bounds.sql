-- Bound anonymous acquisition touchpoints by a stable UTC calendar day.
--
-- occurred_on is deliberately stored rather than generated: deriving a date from timestamptz via
-- the session timezone is not immutable, and independently defaulting occurred_at/occurred_on can
-- disagree across midnight. Writers must supply both values from one captured database timestamp.

ALTER TABLE marketplace_acquisition_touchpoints
    ADD COLUMN occurred_on date;

UPDATE marketplace_acquisition_touchpoints
   SET occurred_on = pg_catalog.timezone('UTC', occurred_at)::date
 WHERE occurred_on IS NULL;

ALTER TABLE marketplace_acquisition_touchpoints
    ALTER COLUMN occurred_on SET NOT NULL,
    ADD CONSTRAINT marketplace_acquisition_touchpoints_occurred_on_utc_check
        CHECK (occurred_on = pg_catalog.timezone('UTC', occurred_at)::date);

CREATE INDEX marketplace_acquisition_touchpoints_link_day_idx
    ON marketplace_acquisition_touchpoints (tenant_id, link_id, occurred_on);
