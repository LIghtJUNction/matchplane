-- A Better Auth identity may participate in several child platforms in one tenant.  Keep the
-- marketplace bearer projection and its auth link scoped to the platform node instead of
-- rotating one tenant-wide token whenever the user changes child paths.
ALTER TABLE marketplace_parties
    ADD COLUMN scope_domain_id uuid,
    ADD COLUMN platform_path text NOT NULL DEFAULT '/'
        CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$');

ALTER TABLE marketplace_parties
    ADD CONSTRAINT marketplace_parties_scope_domain_fk
        FOREIGN KEY (tenant_id, scope_domain_id) REFERENCES domains(tenant_id, id);

CREATE INDEX marketplace_parties_scope_idx
    ON marketplace_parties (tenant_id, scope_domain_id, platform_path, id)
    WHERE status = 'active';

ALTER TABLE marketplace_party_auth_links
    ADD COLUMN platform_path text NOT NULL DEFAULT '/'
        CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$');

ALTER TABLE marketplace_party_auth_links
    DROP CONSTRAINT marketplace_party_auth_links_pkey,
    ADD CONSTRAINT marketplace_party_auth_links_pkey
        PRIMARY KEY (tenant_id, auth_user_id, platform_path);

CREATE INDEX marketplace_party_auth_links_scope_idx
    ON marketplace_party_auth_links (tenant_id, auth_user_id, platform_path);
