BEGIN;

ALTER TABLE marketplace_sales_handoffs
  ADD COLUMN lead_stage text NOT NULL DEFAULT 'new'
    CHECK (lead_stage IN (
      'new',
      'discovering',
      'qualified',
      'contact_requested',
      'contact_exchanged',
      'won',
      'lost'
    )),
  ADD COLUMN favorite boolean NOT NULL DEFAULT false,
  ADD COLUMN contact_consent_status text NOT NULL DEFAULT 'not_requested'
    CHECK (contact_consent_status IN (
      'not_requested',
      'pending',
      'accepted',
      'declined'
    )),
  ADD COLUMN staff_notes text
    CHECK (staff_notes IS NULL OR length(staff_notes) <= 2000),
  ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE OR REPLACE FUNCTION matchplane_sync_handoff_tracking()
RETURNS trigger AS $$
DECLARE
  consent text;
  strength text;
BEGIN
  consent := COALESCE(NEW.summary ->> 'contact_consent', 'not_requested');
  IF consent IN ('not_requested', 'pending', 'accepted', 'declined') THEN
    NEW.contact_consent_status := consent;
  END IF;

  strength := COALESCE(NEW.summary ->> 'intent_strength', '');
  IF NEW.lead_stage = 'new' THEN
    NEW.lead_stage := CASE
      WHEN strength IN ('high', 'urgent') THEN 'qualified'
      WHEN strength = 'warm' THEN 'discovering'
      ELSE 'new'
    END;
  END IF;
  NEW.last_activity_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketplace_sales_handoffs_tracking_sync
BEFORE INSERT OR UPDATE OF summary
ON marketplace_sales_handoffs
FOR EACH ROW EXECUTE FUNCTION matchplane_sync_handoff_tracking();

CREATE INDEX marketplace_sales_handoffs_customer_queue_idx
  ON marketplace_sales_handoffs (
    tenant_id,
    domain_id,
    favorite DESC,
    last_activity_at DESC,
    id DESC
  );

COMMIT;
