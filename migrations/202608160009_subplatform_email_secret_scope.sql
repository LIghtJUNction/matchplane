-- Child administrators may name only a deployment-issued secret slot that belongs to their
-- exact tenant/domain.  The web process resolves this opaque reference below a dedicated,
-- read-only secret root; env:// and file:// remain deployment-only root SMTP references.
ALTER TABLE subplatform_email_configs
    ADD CONSTRAINT subplatform_email_secret_scope_ck
    CHECK (
        credential_secret_ref ~* '^secret://subplatform/[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,128}$'
    );
