-- Root MatchPlane is the OIDC authority for subplatforms hosted on another origin.
-- The schema is generated from @better-auth/oauth-provider 1.6.29.  Keep these
-- tables separate from marketplace capabilities: OAuth tokens establish identity,
-- while the target platform still issues its own short-lived capability.
CREATE TABLE "jwks" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamptz NOT NULL,
    "expiresAt" timestamptz
);

CREATE TABLE "oauthClient" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "clientId" text NOT NULL UNIQUE,
    "clientSecret" text,
    "disabled" boolean,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    "scopes" jsonb,
    "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
    "createdAt" timestamptz,
    "updatedAt" timestamptz,
    "name" text,
    "uri" text,
    "icon" text,
    "contacts" jsonb,
    "tos" text,
    "policy" text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" jsonb NOT NULL,
    "postLogoutRedirectUris" jsonb,
    "tokenEndpointAuthMethod" text,
    "grantTypes" jsonb,
    "responseTypes" jsonb,
    "public" boolean,
    "type" text,
    "requirePKCE" boolean,
    "referenceId" text,
    "metadata" jsonb
);

CREATE TABLE "oauthRefreshToken" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "token" text NOT NULL UNIQUE,
    "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "sessionId" uuid REFERENCES "session" ("id") ON DELETE SET NULL,
    "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "referenceId" text,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL,
    "revoked" timestamptz,
    "authTime" timestamptz,
    "scopes" jsonb NOT NULL
);

CREATE TABLE "oauthAccessToken" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "token" text NOT NULL UNIQUE,
    "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "sessionId" uuid REFERENCES "session" ("id") ON DELETE SET NULL,
    "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
    "referenceId" text,
    "refreshId" uuid REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL,
    "scopes" jsonb NOT NULL
);

CREATE TABLE "oauthConsent" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "userId" uuid REFERENCES "user" ("id") ON DELETE CASCADE,
    "referenceId" text,
    "scopes" jsonb NOT NULL,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
);

CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
