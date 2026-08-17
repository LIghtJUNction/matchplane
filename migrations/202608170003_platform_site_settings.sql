-- Public, operator-owned site metadata for each platform node.
--
-- The root kernel does not infer a legal entity or manufacture an ICP filing number.  A
-- platform administrator may publish the verified values for the current organization; the
-- public web shell only exposes these explicitly saved fields.

CREATE TABLE IF NOT EXISTS platform_site_settings (
    organization_id uuid PRIMARY KEY REFERENCES "organization" ("id") ON DELETE CASCADE,
    tenant_id uuid NOT NULL,
    icp_number text,
    icp_subject text,
    icp_record_url text,
    public_security_number text,
    public_security_url text,
    lookup_source text,
    lookup_checked_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by uuid REFERENCES "user" ("id") ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT platform_site_settings_tenant_scope CHECK (tenant_id IS NOT NULL),
    CONSTRAINT platform_site_settings_icp_number_length CHECK (icp_number IS NULL OR char_length(icp_number) <= 128),
    CONSTRAINT platform_site_settings_icp_subject_length CHECK (icp_subject IS NULL OR char_length(icp_subject) <= 200),
    CONSTRAINT platform_site_settings_icp_url_length CHECK (icp_record_url IS NULL OR char_length(icp_record_url) <= 2_048),
    CONSTRAINT platform_site_settings_public_security_number_length CHECK (public_security_number IS NULL OR char_length(public_security_number) <= 128),
    CONSTRAINT platform_site_settings_public_security_url_length CHECK (public_security_url IS NULL OR char_length(public_security_url) <= 2_048),
    CONSTRAINT platform_site_settings_lookup_source_length CHECK (lookup_source IS NULL OR char_length(lookup_source) <= 2_048)
);

CREATE INDEX IF NOT EXISTS platform_site_settings_tenant_idx
    ON platform_site_settings (tenant_id);

CREATE OR REPLACE FUNCTION matchplane_set_platform_site_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_site_settings_updated_at ON platform_site_settings;
CREATE TRIGGER platform_site_settings_updated_at
BEFORE UPDATE ON platform_site_settings
FOR EACH ROW EXECUTE FUNCTION matchplane_set_platform_site_settings_updated_at();
