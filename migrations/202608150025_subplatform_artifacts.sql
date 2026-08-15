-- A build worker may attach an immutable, host-local static artifact after it
-- has verified the source/build digest.  The path is intentionally opaque to
-- the browser; the public manifest exposes only a scoped asset endpoint.
ALTER TABLE subplatform_registrations
    ADD COLUMN artifact_locator text
        CHECK (artifact_locator IS NULL OR (
            length(artifact_locator) BETWEEN 1 AND 512
            AND artifact_locator !~ '(^/|(^|/)\.\.?(/|$)|\\)'
        )),
    ADD COLUMN artifact_entry text NOT NULL DEFAULT 'index.html'
        CHECK (
            length(artifact_entry) BETWEEN 1 AND 256
            AND artifact_entry !~ '(^/|(^|/)\.\.?(/|$)|\\)'
        );

CREATE INDEX subplatform_registrations_artifact_idx
    ON subplatform_registrations (tenant_id, slug, state)
    WHERE artifact_locator IS NOT NULL;
