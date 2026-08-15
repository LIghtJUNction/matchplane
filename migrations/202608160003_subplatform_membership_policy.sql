-- Public buyers/sellers may claim a member projection only when the node explicitly permits it.
-- Administrators and private nodes still use Better Auth invitations.
ALTER TABLE subplatform_registrations
    ADD COLUMN membership_policy text NOT NULL DEFAULT 'public'
        CHECK (membership_policy IN ('public', 'invite'));

CREATE INDEX subplatform_registrations_membership_policy_idx
    ON subplatform_registrations (tenant_id, slug, state, membership_policy);
