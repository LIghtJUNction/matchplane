-- Keep the Better Auth organization tree referentially valid at the database boundary.
-- The plugin exposes this field as a string, while Better Auth IDs are UUIDs in this deployment.
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_parent_not_self";
ALTER TABLE "organization"
  ALTER COLUMN "parentOrganizationId" TYPE uuid
  USING NULLIF("parentOrganizationId", '')::uuid;
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_parent_not_self"
  CHECK ("parentOrganizationId" IS NULL OR "parentOrganizationId" <> "id");
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_parent_fk"
  FOREIGN KEY ("parentOrganizationId") REFERENCES "organization" ("id") ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION matchplane_prevent_organization_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_id uuid := NEW."parentOrganizationId";
  depth integer := 0;
BEGIN
  WHILE current_id IS NOT NULL LOOP
    depth := depth + 1;
    IF current_id = NEW.id THEN
      RAISE EXCEPTION 'organization parent cycle detected for %', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF depth > 64 THEN
      RAISE EXCEPTION 'organization tree exceeds the maximum depth of 64'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT "parentOrganizationId" INTO current_id
      FROM "organization"
     WHERE id = current_id;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_parent_cycle_guard ON "organization";
CREATE TRIGGER organization_parent_cycle_guard
BEFORE INSERT OR UPDATE OF "parentOrganizationId" ON "organization"
FOR EACH ROW EXECUTE FUNCTION matchplane_prevent_organization_cycle();
