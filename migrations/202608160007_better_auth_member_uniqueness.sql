-- A global Better Auth user may join many organizations, but may only have one member row
-- per organization.  The public SSO claim path is idempotent; this constraint also closes the
-- concurrent-request race between its read and addMember calls.
CREATE UNIQUE INDEX "member_organizationId_userId_uidx"
    ON "member" ("organizationId", "userId");
