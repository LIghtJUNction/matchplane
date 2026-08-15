-- One root Better Auth identity can participate in many tenant-scoped marketplace parties.
-- The link is an authority projection, not a second password or session store.
CREATE TABLE marketplace_party_auth_links (
    tenant_id uuid NOT NULL,
    auth_user_id uuid NOT NULL,
    party_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, auth_user_id),
    UNIQUE (tenant_id, party_id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES marketplace_parties(tenant_id, id)
);

CREATE INDEX marketplace_party_auth_links_party_idx
    ON marketplace_party_auth_links (tenant_id, party_id);

CREATE TRIGGER marketplace_party_auth_links_updated_at
BEFORE UPDATE ON marketplace_party_auth_links
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
