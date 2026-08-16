-- Mark the deployment's root Better Auth organization explicitly.
--
-- A root tenant may already contain child organizations (and older installations may have
-- created one without a parent), so parentOrganizationId IS NULL is not a sufficient root
-- discriminator.  This flag keeps the root scope data-driven and avoids binding root access to
-- a child package such as an automotive adapter.

ALTER TABLE "organization"
    ADD COLUMN IF NOT EXISTS "rootPlatform" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS organization_one_root_per_tenant_idx
    ON "organization" ("tenantId")
    WHERE "rootPlatform" = true;

ALTER TABLE "organization"
    ADD CONSTRAINT organization_root_platform_must_be_top_level
    CHECK ("rootPlatform" = false OR "parentOrganizationId" IS NULL);
