-- Seller listing authorization is explicit: a tenant-scoped asset reference alone does not
-- prove that the authenticated seller is allowed to advertise the vehicle.

CREATE TABLE marketplace_asset_authorizations (
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    seller_party_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    authorized_by text NOT NULL CHECK (length(authorized_by) BETWEEN 1 AND 256),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, domain_id, asset_id, seller_party_id),
    FOREIGN KEY (tenant_id, domain_id, asset_id)
        REFERENCES assets(tenant_id, domain_id, id),
    FOREIGN KEY (tenant_id, seller_party_id)
        REFERENCES marketplace_parties(tenant_id, id)
);

CREATE INDEX marketplace_asset_authorizations_seller_idx
    ON marketplace_asset_authorizations (tenant_id, seller_party_id, status);

CREATE TRIGGER marketplace_asset_authorizations_updated_at
BEFORE UPDATE ON marketplace_asset_authorizations
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
