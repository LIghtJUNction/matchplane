-- Public mall branding is tenant-scoped. Personal biographies and locally managed avatars remain
-- account-scoped; neither becomes a marketplace contact channel.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS brand_logo_key text
        CHECK (brand_logo_key IS NULL OR brand_logo_key ~ '^brand/[0-9a-f-]{36}/[0-9a-f-]{36}\\.webp$');

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT ''
        CHECK (char_length(bio) <= 500),
    ADD COLUMN IF NOT EXISTS profile_avatar_key text
        CHECK (profile_avatar_key IS NULL OR profile_avatar_key ~ '^profile/[0-9a-f-]{36}/[0-9a-f-]{36}\\.webp$');
