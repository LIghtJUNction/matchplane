-- Root identities may participate in many domain-specific subplatforms.
-- A membership is the scoped role/tag assignment; it is not another account.
CREATE TABLE marketplace_subplatform_memberships (
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    party_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('buyer', 'seller', 'both', 'admin')),
    labels text[] NOT NULL DEFAULT ARRAY[]::text[],
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    approved_at timestamptz,
    approved_by text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, domain_id, party_id),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES marketplace_parties(tenant_id, id),
    CHECK (cardinality(labels) <= 32),
    CHECK ((status = 'active' AND approved_at IS NOT NULL) OR status <> 'active')
);

CREATE INDEX marketplace_subplatform_memberships_party_idx
    ON marketplace_subplatform_memberships (tenant_id, party_id, status);

CREATE INDEX marketplace_subplatform_memberships_domain_role_idx
    ON marketplace_subplatform_memberships (tenant_id, domain_id, role, status);

CREATE TRIGGER marketplace_subplatform_memberships_updated_at
BEFORE UPDATE ON marketplace_subplatform_memberships
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();
