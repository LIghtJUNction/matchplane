-- Bind canonical marketplace offers to one manifest-declared product template identifier.
-- Historical offers remain NULL so legacy manifests without productTemplates keep working.
ALTER TABLE marketplace_offers
  ADD COLUMN IF NOT EXISTS product_template_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'marketplace_offers'::regclass
       AND conname = 'marketplace_offers_product_template_id_format'
  ) THEN
    ALTER TABLE marketplace_offers
      ADD CONSTRAINT marketplace_offers_product_template_id_format
      CHECK (
        product_template_id IS NULL
        OR product_template_id ~ '^[a-z][a-z0-9._-]{0,63}$'
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_marketplace_offers_tenant_store_template_status
  ON marketplace_offers (tenant_id, store_id, product_template_id, status);
