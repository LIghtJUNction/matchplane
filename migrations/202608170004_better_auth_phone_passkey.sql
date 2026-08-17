-- Better Auth phone-number and passkey plugin fields.
-- These are additive and match the UUID id policy used by this deployment.

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "phoneNumber" text,
    ADD COLUMN IF NOT EXISTS "phoneNumberVerified" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "user_phoneNumber_uidx"
    ON "user" ("phoneNumber")
    WHERE "phoneNumber" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "passkey" (
    "id" uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL PRIMARY KEY,
    "name" text,
    "publicKey" text NOT NULL,
    "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "credentialID" text NOT NULL,
    "counter" integer NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    "transports" text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
    "aaguid" text
);

CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON "passkey" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credentialID_uidx" ON "passkey" ("credentialID");
