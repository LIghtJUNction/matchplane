BEGIN;

ALTER TABLE "user"
    DROP CONSTRAINT IF EXISTS user_profile_avatar_key_check,
    ADD CONSTRAINT user_profile_avatar_key_check
        CHECK (
            profile_avatar_key IS NULL
            OR profile_avatar_key ~ '^profile/[0-9a-f-]{36}/[0-9a-f-]{36}[.]webp$'
        );

ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_brand_logo_key_check,
    ADD CONSTRAINT tenants_brand_logo_key_check
        CHECK (
            brand_logo_key IS NULL
            OR brand_logo_key ~ '^brand/[0-9a-f-]{36}/[0-9a-f-]{36}[.]webp$'
        );

COMMIT;
