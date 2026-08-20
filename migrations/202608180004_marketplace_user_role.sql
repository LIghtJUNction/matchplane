-- Buyer/seller identity is selected once during public registration and reused at every login.
-- It is deliberately separate from Better Auth's administrative `role` field.
ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "marketplaceRole" text NOT NULL DEFAULT 'buyer'
        CHECK ("marketplaceRole" IN ('buyer', 'seller'));
