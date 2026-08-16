-- Better Auth organization membership is the human identity projection used by federated
-- capability checks.  Make the claim/invite operation idempotent at the database boundary so two
-- simultaneous first visits cannot create two roles for the same user in one node.
CREATE UNIQUE INDEX "member_organization_user_unique"
    ON "member" ("organizationId", "userId");
