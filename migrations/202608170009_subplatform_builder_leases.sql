-- Short leases let an isolated builder retry a job after a crash without allowing
-- two live workers to publish the same registration at once.  The builder never
-- receives a database credential; the web control plane owns these fields.
ALTER TABLE subplatform_registrations
    ADD COLUMN build_lease_id uuid,
    ADD COLUMN build_started_at timestamptz,
    ADD COLUMN build_attempts integer NOT NULL DEFAULT 0
        CHECK (build_attempts BETWEEN 0 AND 100),
    ADD COLUMN build_error text
        CHECK (build_error IS NULL OR length(build_error) BETWEEN 1 AND 4000);

CREATE INDEX subplatform_registrations_builder_queue_idx
    ON subplatform_registrations (state, registered_at)
    WHERE state IN ('validated', 'building');
