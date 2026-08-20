-- Stable two-layer marketplace projection.
--
-- Better Auth organizations and immutable package registrations remain compatibility and
-- authorization records.  A store is the commercial identity shown in the marketplace and is
-- always attached directly to the deployment's single root organization.

-- A store pointer is only meaningful inside one concrete registration scope.  The legacy
-- single-column foreign keys are insufficient here: a UUID from another tenant/domain/slug
-- would still satisfy them.  Keep the nullable pointers for legacy rows, but make every
-- populated pointer prove its full scope at the database boundary.
ALTER TABLE subplatform_registrations
    ADD CONSTRAINT subplatform_registrations_store_scope_uidx
        UNIQUE (tenant_id, domain_id, slug, id);

ALTER TABLE platform_federation_bindings
    ADD CONSTRAINT platform_federation_bindings_store_scope_uidx
        UNIQUE (tenant_id, domain_id, slug, organization_id, id);

CREATE TABLE stores (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    organization_id uuid NOT NULL UNIQUE REFERENCES "organization"(id),
    domain_id uuid NOT NULL,
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
    visibility text NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'private')),
    integration_kind text NOT NULL DEFAULT 'package'
        CHECK (integration_kind IN ('hosted', 'package', 'external')),
    current_registration_id uuid,
    federation_binding_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, domain_id, id),
    UNIQUE (tenant_id, slug),
    FOREIGN KEY (tenant_id, domain_id, slug, current_registration_id)
        REFERENCES subplatform_registrations(tenant_id, domain_id, slug, id),
    FOREIGN KEY (tenant_id, domain_id, slug, organization_id, federation_binding_id)
        REFERENCES platform_federation_bindings(tenant_id, domain_id, slug, organization_id, id)
);

CREATE INDEX stores_directory_idx
    ON stores (tenant_id, visibility, status, created_at DESC);

CREATE TABLE store_path_aliases (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    store_id uuid NOT NULL,
    path text NOT NULL CHECK (path ~ '^/[a-z0-9][a-z0-9-]{1,62}$'),
    is_canonical boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, path),
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX store_path_aliases_one_canonical_idx
    ON store_path_aliases (tenant_id, store_id)
    WHERE is_canonical;

-- A canonical storefront path is derived from the store slug.  Do not let an alias be silently
-- reassigned to another store: marketplace parties use this path as an authority scope.
CREATE FUNCTION matchplane_validate_store_path_alias() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    store_slug text;
BEGIN
    SELECT slug
      INTO store_slug
      FROM stores
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.store_id;

    IF store_slug IS NULL THEN
        RAISE EXCEPTION 'store path alias references an unknown scoped store'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.is_canonical AND NEW.path <> '/' || store_slug THEN
        RAISE EXCEPTION 'canonical store path % must equal /%', NEW.path, store_slug
            USING ERRCODE = 'check_violation';
    END IF;
    -- Do not turn a canonical party scope into a stale alias by editing the alias underneath it.
    -- The explicit migration/backfill path always writes parties after aliases, so this guard
    -- affects only later direct mutations that would otherwise bypass the party trigger.  This
    -- function also runs while aliases are backfilled, before the migration adds party.store_id,
    -- so the pre-existing tenant/path authority is deliberately sufficient here.
    IF TG_OP = 'UPDATE'
       AND OLD.is_canonical
       AND (NEW.tenant_id, NEW.store_id, NEW.path, NEW.is_canonical)
           IS DISTINCT FROM (OLD.tenant_id, OLD.store_id, OLD.path, OLD.is_canonical)
       AND EXISTS (
           SELECT 1
             FROM marketplace_parties party
            WHERE party.tenant_id = OLD.tenant_id
              AND party.platform_path = OLD.path
       ) THEN
        RAISE EXCEPTION 'cannot mutate a canonical store alias while marketplace parties use that path'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER store_path_aliases_scope_guard
BEFORE INSERT OR UPDATE OF tenant_id, store_id, path, is_canonical
ON store_path_aliases
FOR EACH ROW EXECUTE FUNCTION matchplane_validate_store_path_alias();

-- A live store may point only at the active registration for the exact
-- tenant/domain/slug/organization scope.  Suspended historical stores deliberately retain their
-- nullable-or-disabled registration pointer so an older release cannot later become live again.
CREATE FUNCTION matchplane_validate_store_projection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    registration_state text;
    registration_binding_id uuid;
    binding_status text;
    canonical_path text;
BEGIN
    IF NEW.current_registration_id IS NULL THEN
        IF NEW.federation_binding_id IS NOT NULL THEN
            RAISE EXCEPTION 'a store federation binding requires a current registration'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'active' AND NEW.integration_kind <> 'hosted' THEN
            RAISE EXCEPTION 'an active connected store requires an active scoped registration'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        SELECT r.state, r.federation_binding_id
          INTO registration_state, registration_binding_id
          FROM subplatform_registrations r
         WHERE r.tenant_id = NEW.tenant_id
           AND r.domain_id = NEW.domain_id
           AND r.slug = NEW.slug
           AND r.id = NEW.current_registration_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'store registration pointer does not match its tenant/domain/slug scope'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF NEW.status = 'active' AND registration_state <> 'active' THEN
            RAISE EXCEPTION 'an active store cannot point at registration state %', registration_state
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.federation_binding_id IS DISTINCT FROM registration_binding_id THEN
            RAISE EXCEPTION 'store federation binding must be the binding recorded by its current registration'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.federation_binding_id IS NOT NULL THEN
            SELECT b.status
              INTO binding_status
              FROM platform_federation_bindings b
             WHERE b.tenant_id = NEW.tenant_id
               AND b.domain_id = NEW.domain_id
               AND b.slug = NEW.slug
               AND b.organization_id = NEW.organization_id
               AND b.id = NEW.federation_binding_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'store federation binding does not match its tenant/domain/path organization scope'
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            IF NEW.status = 'active' AND binding_status <> 'active' THEN
                RAISE EXCEPTION 'an active store cannot use federation binding state %', binding_status
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    SELECT path
      INTO canonical_path
      FROM store_path_aliases
     WHERE tenant_id = NEW.tenant_id
       AND store_id = NEW.id
       AND is_canonical;
    IF canonical_path IS NOT NULL AND canonical_path <> '/' || NEW.slug THEN
        RAISE EXCEPTION 'store slug and canonical path disagree'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER stores_updated_at
BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TRIGGER stores_projection_scope_guard
BEFORE INSERT OR UPDATE OF tenant_id, organization_id, domain_id, slug, status, integration_kind,
    current_registration_id, federation_binding_id
ON stores
FOR EACH ROW EXECUTE FUNCTION matchplane_validate_store_projection();

CREATE TABLE store_commercial_terms (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    store_id uuid NOT NULL,
    pricing_model text NOT NULL DEFAULT 'none'
        CHECK (pricing_model IN ('none', 'subscription', 'commission', 'hybrid')),
    recurring_fee_minor numeric(38, 0) NOT NULL DEFAULT 0
        CHECK (recurring_fee_minor >= 0 AND scale(recurring_fee_minor) = 0),
    currency text NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
    billing_interval text CHECK (billing_interval IN ('month', 'year')),
    commission_bps integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, store_id),
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE,
    CHECK (
        (pricing_model = 'none'
            AND recurring_fee_minor = 0
            AND billing_interval IS NULL
            AND commission_bps = 0)
        OR (pricing_model = 'subscription'
            AND recurring_fee_minor > 0
            AND billing_interval IS NOT NULL
            AND commission_bps = 0)
        OR (pricing_model = 'commission'
            AND recurring_fee_minor = 0
            AND billing_interval IS NULL
            AND commission_bps > 0)
        OR (pricing_model = 'hybrid'
            AND recurring_fee_minor > 0
            AND billing_interval IS NOT NULL
            AND commission_bps > 0)
    )
);

CREATE TRIGGER store_commercial_terms_updated_at
BEFORE UPDATE ON store_commercial_terms FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TABLE hosted_store_media (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL,
    store_id uuid NOT NULL,
    uploader_subject text NOT NULL CHECK (length(uploader_subject) BETWEEN 1 AND 200),
    storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f-]{36}\.[a-z0-9]{2,8}$'),
    file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
    media_type text NOT NULL CHECK (media_type ~ '^image/[a-z0-9.+-]+$'),
    size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'published', 'rejected', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX hosted_store_media_store_idx
    ON hosted_store_media (tenant_id, store_id, status, created_at DESC);

-- Backfill only direct children of the root with an actually-active registration. Historical
-- nested, pending, rejected and disabled nodes remain on the nullable legacy path until an
-- operator resolves them explicitly; they must never become a live store merely because they
-- are the newest row in a registration history.
--
-- The checks intentionally fail the migration rather than selecting an arbitrary alias when a
-- historical remote registration claims an incompatible federation binding.  An operator must
-- repair that source record first; silently attaching its offers to another store is unsafe.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM subplatform_registrations r
          JOIN "organization" child
            ON child."tenantId" = r.tenant_id::text
           AND child."domainId" = r.domain_id::text
           AND child.slug = r.slug
          JOIN "organization" root
            ON root.id = child."parentOrganizationId"
           AND root."tenantId" = child."tenantId"
           AND root."rootPlatform" = true
           AND root."parentOrganizationId" IS NULL
          LEFT JOIN platform_federation_bindings binding
            ON binding.id = r.federation_binding_id
         WHERE r.state = 'active'
           AND r.federation_binding_id IS NOT NULL
           AND (
               binding.id IS NULL
               OR binding.tenant_id <> r.tenant_id
               OR binding.domain_id <> r.domain_id
               OR binding.slug <> r.slug
               OR binding.organization_id <> child.id
               OR binding.registration_id <> r.id
               OR binding.status <> 'active'
           )
    ) THEN
        RAISE EXCEPTION 'flat-store migration found an active registration with an incompatible federation binding; repair the registration/binding scope before retrying'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
END;
$$;

WITH roots AS (
    SELECT id, "tenantId"
      FROM "organization"
     WHERE "rootPlatform" = true
       AND "parentOrganizationId" IS NULL
), direct_children AS (
    SELECT child.id AS organization_id,
           child."tenantId"::uuid AS tenant_id,
           child."domainId"::uuid AS domain_id,
           child.slug,
           child.name,
           registration.id AS registration_id,
           registration.source_kind,
           registration.membership_policy,
           registration.federation_binding_id,
           COALESCE(registration.manifest ->> 'description', '') AS description,
           registration.registered_by
      FROM "organization" child
      JOIN roots root
        ON child."parentOrganizationId" = root.id
       AND child."tenantId" = root."tenantId"
      JOIN LATERAL (
        SELECT r.*
          FROM subplatform_registrations r
         WHERE r.tenant_id::text = child."tenantId"
           AND r.domain_id = NULLIF(child."domainId", '')::uuid
           AND r.slug = child.slug
           AND r.state = 'active'
         -- An activation can briefly leave an older row active while its successor is being
         -- committed.  The highest active version is the only authoritative projection.
         ORDER BY r.version DESC
         LIMIT 1
      ) registration ON true
     WHERE child."rootPlatform" = false
       AND NULLIF(child."domainId", '') IS NOT NULL
)
INSERT INTO stores
    (tenant_id, organization_id, domain_id, slug, display_name, description, status,
     visibility, integration_kind, current_registration_id, federation_binding_id, created_by)
SELECT tenant_id,
       organization_id,
       domain_id,
       slug,
       name,
       description,
       'active',
       CASE WHEN membership_policy = 'public' THEN 'public' ELSE 'private' END,
       CASE WHEN source_kind = 'remote' THEN 'external' ELSE 'package' END,
       registration_id,
       federation_binding_id,
       registered_by
  FROM direct_children;

INSERT INTO store_path_aliases (tenant_id, store_id, path, is_canonical)
SELECT tenant_id, id, '/' || slug, true
  FROM stores;

INSERT INTO store_commercial_terms (tenant_id, store_id)
SELECT tenant_id, id
  FROM stores
ON CONFLICT (tenant_id, store_id) DO NOTHING;

ALTER TABLE marketplace_parties
    ADD COLUMN store_id uuid,
    ADD CONSTRAINT marketplace_parties_store_fk
        FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id),
    ADD CONSTRAINT marketplace_parties_store_scope_fk
        FOREIGN KEY (tenant_id, scope_domain_id, store_id)
            REFERENCES stores(tenant_id, domain_id, id),
    ADD CONSTRAINT marketplace_parties_store_requires_domain_check
        CHECK (store_id IS NULL OR scope_domain_id IS NOT NULL);

CREATE FUNCTION matchplane_assign_party_store() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    expected_store_id uuid;
    expected_domain_id uuid;
BEGIN
    -- Only a canonical path can own a storefront party.  A non-canonical alias may still be a
    -- routing convenience, but it must never become a second authorization scope.
    SELECT alias.store_id, store.domain_id
      INTO expected_store_id, expected_domain_id
      FROM store_path_aliases alias
      JOIN stores store
        ON store.tenant_id = alias.tenant_id
       AND store.id = alias.store_id
     WHERE alias.tenant_id = NEW.tenant_id
       AND alias.path = NEW.platform_path
       AND alias.is_canonical;

    IF FOUND THEN
        IF NEW.scope_domain_id IS DISTINCT FROM expected_domain_id THEN
            RAISE EXCEPTION 'marketplace party domain does not match canonical store path %', NEW.platform_path
                USING ERRCODE = 'check_violation';
        END IF;
        NEW.store_id := expected_store_id;
    ELSE
        IF EXISTS (
            SELECT 1
              FROM store_path_aliases alias
             WHERE alias.tenant_id = NEW.tenant_id
               AND alias.path = NEW.platform_path
        ) THEN
            RAISE EXCEPTION 'marketplace party path % is a non-canonical store alias', NEW.platform_path
                USING ERRCODE = 'check_violation';
        END IF;
        -- Legacy/root parties are intentionally nullable fallbacks.  Recompute even a direct
        -- caller update so a stale or forged store_id cannot survive a path change.
        NEW.store_id := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_parties_assign_store
BEFORE INSERT OR UPDATE OF tenant_id, scope_domain_id, platform_path, store_id ON marketplace_parties
FOR EACH ROW EXECUTE FUNCTION matchplane_assign_party_store();

-- Run every row through the trigger.  This is deliberately not a NULL-only backfill: old or
-- caller-supplied values are rejected/recomputed under the same tenant+domain+canonical-path
-- contract that protects new writes.
UPDATE marketplace_parties
   SET store_id = store_id;

CREATE INDEX marketplace_parties_store_idx
    ON marketplace_parties (tenant_id, store_id, status)
    WHERE store_id IS NOT NULL;

ALTER TABLE marketplace_offers
    ADD COLUMN store_id uuid,
    ADD CONSTRAINT marketplace_offers_store_fk
        FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id),
    ADD CONSTRAINT marketplace_offers_store_scope_fk
        FOREIGN KEY (tenant_id, domain_id, store_id)
            REFERENCES stores(tenant_id, domain_id, id);

ALTER TABLE marketplace_offers
    DROP CONSTRAINT IF EXISTS marketplace_offers_tenant_id_domain_id_external_key_key;

CREATE UNIQUE INDEX marketplace_offers_store_external_key_idx
    ON marketplace_offers (tenant_id, store_id, external_key)
    WHERE store_id IS NOT NULL;

CREATE UNIQUE INDEX marketplace_offers_legacy_external_key_idx
    ON marketplace_offers (tenant_id, domain_id, external_key)
    WHERE store_id IS NULL;

CREATE INDEX marketplace_offers_public_store_idx
    ON marketplace_offers (tenant_id, store_id, status, published_at DESC)
    WHERE store_id IS NOT NULL;

CREATE FUNCTION matchplane_assign_offer_store() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    party_store_id uuid;
    party_store_domain_id uuid;
    party_scope_domain_id uuid;
    party_platform_path text;
    canonical_store_id uuid;
BEGIN
    SELECT party.store_id, store.domain_id, party.scope_domain_id, party.platform_path
      INTO party_store_id, party_store_domain_id, party_scope_domain_id, party_platform_path
      FROM marketplace_parties party
      LEFT JOIN stores store
        ON store.tenant_id = party.tenant_id
       AND store.id = party.store_id
     WHERE party.tenant_id = NEW.tenant_id
       AND party.id = NEW.supply_party_id;

    -- The supply party is authoritative. This both fills hosted-store offers and clears a stale
    -- or caller-supplied store id when an offer is moved to a legacy, non-store party.
    NEW.store_id := party_store_id;
    IF party_store_id IS NOT NULL THEN
        SELECT alias.store_id
          INTO canonical_store_id
          FROM store_path_aliases alias
         WHERE alias.tenant_id = NEW.tenant_id
           AND alias.path = party_platform_path
           AND alias.is_canonical;
        IF canonical_store_id IS DISTINCT FROM party_store_id
           OR party_scope_domain_id IS DISTINCT FROM party_store_domain_id
           OR party_store_domain_id IS DISTINCT FROM NEW.domain_id THEN
            RAISE EXCEPTION 'offer, supply party and canonical store must share one tenant/domain/path scope'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_offers_assign_store
BEFORE INSERT OR UPDATE OF tenant_id, domain_id, supply_party_id, store_id ON marketplace_offers
FOR EACH ROW EXECUTE FUNCTION matchplane_assign_offer_store();

UPDATE marketplace_offers
   SET store_id = store_id;

-- New integrations are projected only after their exact registration is active and is the
-- highest active version for the scoped path.  Pending/rejected rows never create or overwrite
-- a store.  When a formerly-current release is disabled, the store is suspended only if it
-- still points at that exact release; disabling an older release after a newer activation is a
-- no-op for the live projection.
CREATE FUNCTION matchplane_project_store_registration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    store_organization_id uuid;
    existing_registration_id uuid;
    current_registration_version bigint;
    highest_active_version bigint;
    existing_alias_store_id uuid;
BEGIN
    IF NEW.state <> 'active' THEN
        IF TG_OP = 'UPDATE' AND OLD.state = 'active' THEN
            UPDATE stores
               SET status = 'suspended',
                   version = version + 1,
                   updated_at = clock_timestamp()
             WHERE current_registration_id = OLD.id
               AND status = 'active';
        END IF;
        RETURN NEW;
    END IF;

    -- A state transition can temporarily leave two active rows in the same transaction.  Only
    -- the greatest active version is authoritative; an update to an older active history row
    -- cannot overwrite the store that the newer release already owns.
    SELECT MAX(version)
      INTO highest_active_version
      FROM subplatform_registrations
     WHERE tenant_id = NEW.tenant_id
       AND domain_id = NEW.domain_id
       AND slug = NEW.slug
       AND state = 'active';
    IF highest_active_version IS DISTINCT FROM NEW.version THEN
        RETURN NEW;
    END IF;

    SELECT child.id
      INTO store_organization_id
      FROM "organization" child
      JOIN "organization" root
        ON root.id = child."parentOrganizationId"
       AND root."tenantId" = child."tenantId"
       AND root."rootPlatform" = true
       AND root."parentOrganizationId" IS NULL
     WHERE child."tenantId" = NEW.tenant_id::text
       AND child."domainId" = NEW.domain_id::text
       AND child.slug = NEW.slug
       AND child."rootPlatform" = false
     LIMIT 1;

    IF store_organization_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Remote registrations are inserted before their binding is promoted to active by the
    -- enrollment transaction.  Wait for the binding trigger below rather than creating a live
    -- store with an unverifiable remote scope.
    IF NEW.federation_binding_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM platform_federation_bindings binding
         WHERE binding.id = NEW.federation_binding_id
           AND binding.tenant_id = NEW.tenant_id
           AND binding.domain_id = NEW.domain_id
           AND binding.slug = NEW.slug
           AND binding.organization_id = store_organization_id
           AND binding.registration_id = NEW.id
           AND binding.status = 'active'
    ) THEN
        RETURN NEW;
    END IF;

    -- Serialize one logical store path.  The row lock prevents two concurrent activation
    -- transactions from observing the same old version and racing an alias reassignment.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.tenant_id::text || ':' || NEW.domain_id::text || ':' || NEW.slug, 0)
    );

    SELECT store.current_registration_id
      INTO existing_registration_id
      FROM stores store
     WHERE store.organization_id = store_organization_id
     FOR UPDATE;

    IF FOUND THEN
        SELECT registration.version
          INTO current_registration_version
          FROM subplatform_registrations registration
         WHERE registration.id = existing_registration_id;
        IF existing_registration_id IS DISTINCT FROM NEW.id
           AND COALESCE(current_registration_version, 0) >= NEW.version THEN
            -- The current projection is at least as new as this active row.  This includes a
            -- late update to an old active registration and is intentionally a no-op.
            RETURN NEW;
        END IF;

        UPDATE stores
           SET display_name = child.name,
               description = COALESCE(NEW.manifest ->> 'description', ''),
               visibility = CASE WHEN NEW.membership_policy = 'public' THEN 'public' ELSE 'private' END,
               integration_kind = CASE WHEN NEW.source_kind = 'remote' THEN 'external' ELSE 'package' END,
               current_registration_id = NEW.id,
               federation_binding_id = NEW.federation_binding_id,
               status = 'active',
               version = stores.version + 1,
               updated_at = clock_timestamp()
          FROM "organization" child
         WHERE stores.organization_id = store_organization_id
           AND child.id = store_organization_id;
    ELSE
        INSERT INTO stores
            (tenant_id, organization_id, domain_id, slug, display_name, description, status,
             visibility, integration_kind, current_registration_id, federation_binding_id, created_by)
        SELECT NEW.tenant_id,
               child.id,
               NEW.domain_id,
               NEW.slug,
               child.name,
               COALESCE(NEW.manifest ->> 'description', ''),
               'active',
               CASE WHEN NEW.membership_policy = 'public' THEN 'public' ELSE 'private' END,
               CASE WHEN NEW.source_kind = 'remote' THEN 'external' ELSE 'package' END,
               NEW.id,
               NEW.federation_binding_id,
               NEW.registered_by
          FROM "organization" child
         WHERE child.id = store_organization_id;
    END IF;

    SELECT alias.store_id
      INTO existing_alias_store_id
      FROM store_path_aliases alias
     WHERE alias.tenant_id = NEW.tenant_id
       AND alias.path = '/' || NEW.slug
     FOR UPDATE;
    IF FOUND AND existing_alias_store_id <> (
        SELECT store.id FROM stores store WHERE store.organization_id = store_organization_id
    ) THEN
        RAISE EXCEPTION 'canonical store path /% is already owned by another store', NEW.slug
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO store_path_aliases (tenant_id, store_id, path, is_canonical)
    SELECT NEW.tenant_id, store.id, '/' || store.slug, true
      FROM stores store
     WHERE store.organization_id = store_organization_id
    ON CONFLICT (tenant_id, path) DO UPDATE
       SET is_canonical = true
     WHERE store_path_aliases.store_id = EXCLUDED.store_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'canonical store path /% collided with another store', NEW.slug
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO store_commercial_terms (tenant_id, store_id)
    SELECT NEW.tenant_id, store.id
      FROM stores store
     WHERE store.organization_id = store_organization_id
    ON CONFLICT (tenant_id, store_id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- A federation enrollment inserts its immutable registration before promoting the binding to
-- active.  Touch the registration only after the complete binding scope is committed so the
-- registration projection above can create a verifiably scoped live store.  Revocation/degraded
-- status suspends only stores that still reference that binding.
CREATE FUNCTION matchplane_reconcile_store_federation_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'active' THEN
        UPDATE stores
           SET status = 'suspended',
               version = version + 1,
               updated_at = clock_timestamp()
         WHERE federation_binding_id = NEW.id
           AND status = 'active';
        RETURN NEW;
    END IF;

    IF NEW.registration_id IS NOT NULL THEN
        UPDATE subplatform_registrations
           SET state = state
         WHERE id = NEW.registration_id
           AND federation_binding_id = NEW.id
           AND state = 'active';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subplatform_registrations_project_store
AFTER INSERT OR UPDATE OF state, version, manifest, membership_policy, source_kind,
    federation_binding_id
ON subplatform_registrations
FOR EACH ROW EXECUTE FUNCTION matchplane_project_store_registration();

CREATE TRIGGER platform_federation_bindings_reconcile_store
AFTER INSERT OR UPDATE OF status, organization_id, registration_id
ON platform_federation_bindings
FOR EACH ROW EXECUTE FUNCTION matchplane_reconcile_store_federation_binding();
