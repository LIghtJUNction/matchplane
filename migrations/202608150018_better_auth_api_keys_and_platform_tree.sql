-- Better Auth API-key plugin schema plus the recursive platform relationship.
-- Keep this migration aligned with @better-auth/api-key; do not store raw keys.

CREATE TABLE "apikey" (
    "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
    "configId" text NOT NULL,
    "name" text,
    "start" text,
    "referenceId" text NOT NULL,
    "prefix" text,
    "key" text NOT NULL,
    "refillInterval" integer,
    "refillAmount" integer,
    "lastRefillAt" timestamptz,
    "enabled" boolean,
    "rateLimitEnabled" boolean,
    "rateLimitTimeWindow" integer,
    "rateLimitMax" integer,
    "requestCount" integer,
    "remaining" integer,
    "lastRequest" timestamptz,
    "expiresAt" timestamptz,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL,
    "permissions" text,
    "metadata" text
);

CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");

ALTER TABLE "organization"
    ADD COLUMN "parentOrganizationId" text;

ALTER TABLE "organization"
    ADD CONSTRAINT "organization_parent_not_self"
    CHECK ("parentOrganizationId" IS NULL OR "parentOrganizationId" <> "id"::text);

CREATE INDEX "organization_parentOrganizationId_idx"
    ON "organization" ("parentOrganizationId");
