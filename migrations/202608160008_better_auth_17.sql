-- Better Auth 1.7 upgrade for the root OIDC authority.
--
-- 1.7 adds RFC 8707 resource indicators and refresh-token rotation state.  Keep
-- this as an additive migration: 202608160006 is already applied in existing
-- installations and must remain an accurate record of the 1.6 schema.

-- Better Auth core now namespaces linked accounts by issuer.  Existing local
-- and configured OAuth accounts used providerId as their issuer namespace.
ALTER TABLE "account"
    ADD COLUMN IF NOT EXISTS "issuer" text;

UPDATE "account"
SET "issuer" = "providerId"
WHERE "issuer" IS NULL;

ALTER TABLE "account"
    ALTER COLUMN "issuer" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx"
    ON "account" ("issuer", "accountId");

-- The Better Auth JWT plugin persists the key algorithm and curve alongside
-- the existing key material.
ALTER TABLE "jwks"
    ADD COLUMN IF NOT EXISTS "alg" text,
    ADD COLUMN IF NOT EXISTS "crv" text;

ALTER TABLE "oauthClient"
    ADD COLUMN IF NOT EXISTS "clientDiscoveryId" text,
    ADD COLUMN IF NOT EXISTS "clientCredentialsScopes" jsonb,
    ADD COLUMN IF NOT EXISTS "backchannelLogoutUri" text,
    ADD COLUMN IF NOT EXISTS "backchannelLogoutSessionRequired" boolean,
    ADD COLUMN IF NOT EXISTS "applicationType" text,
    ADD COLUMN IF NOT EXISTS "jwks" text,
    ADD COLUMN IF NOT EXISTS "jwksUri" text,
    ADD COLUMN IF NOT EXISTS "dpopBoundAccessTokens" boolean;

CREATE TABLE IF NOT EXISTS "oauthResource" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "identifier" text NOT NULL UNIQUE,
    "name" text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" jsonb,
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean,
    "disabled" boolean,
    "createdAt" timestamptz,
    "updatedAt" timestamptz,
    "policyVersion" integer,
    "metadata" jsonb
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "resourceId" text NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
    "metadata" jsonb,
    "createdAt" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx"
    ON "oauthClientResource" ("clientId", "resourceId");

CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx"
    ON "oauthClientResource" ("clientId");

CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx"
    ON "oauthClientResource" ("resourceId");

ALTER TABLE "oauthRefreshToken"
    ADD COLUMN IF NOT EXISTS "authorizationCodeId" text,
    ADD COLUMN IF NOT EXISTS "resources" jsonb,
    ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" jsonb,
    ADD COLUMN IF NOT EXISTS "rotatedAt" timestamptz,
    ADD COLUMN IF NOT EXISTS "rotationReplayResponse" text,
    ADD COLUMN IF NOT EXISTS "rotationReplayExpiresAt" timestamptz,
    ADD COLUMN IF NOT EXISTS "confirmation" jsonb;

CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx"
    ON "oauthRefreshToken" ("authorizationCodeId");

ALTER TABLE "oauthAccessToken"
    ADD COLUMN IF NOT EXISTS "authorizationCodeId" text,
    ADD COLUMN IF NOT EXISTS "resources" jsonb,
    ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" jsonb,
    ADD COLUMN IF NOT EXISTS "revoked" timestamptz,
    ADD COLUMN IF NOT EXISTS "confirmation" jsonb;

CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx"
    ON "oauthAccessToken" ("authorizationCodeId");

ALTER TABLE "oauthConsent"
    ADD COLUMN IF NOT EXISTS "resources" jsonb,
    ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" jsonb;

-- private_key_jwt assertion replay-protection storage.  The UUID id follows
-- this installation's Better Auth generateId policy.
CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL
);
