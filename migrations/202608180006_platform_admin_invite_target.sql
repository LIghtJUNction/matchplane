-- Root super administrators issue bounded platform-admin registration links from the control plane.
ALTER TABLE platform_admin_invites
    ADD COLUMN target_email text CHECK (target_email IS NULL OR length(target_email) BETWEEN 3 AND 320);
