-- Prevent two non-revoked remote bindings from claiming the same tenant/path slug.
-- Revoked history remains auditable and may be reused only through a new enrollment flow.
CREATE UNIQUE INDEX platform_federation_bindings_tenant_slug_active_uidx
    ON platform_federation_bindings (tenant_id, slug)
    WHERE status <> 'revoked';
