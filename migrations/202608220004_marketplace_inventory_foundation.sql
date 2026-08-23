-- Canonical generic-marketplace inventory foundation.
--
-- This migration is deliberately additive. It does not enable checkout reservations. Existing
-- writers continue using attributes.stock_quantity through a temporary compatibility trigger,
-- while all newly stored state has one canonical quantity and inventory version.

CREATE FUNCTION marketplace_inventory_stock_is_valid(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  numeric_value numeric;
BEGIN
  IF payload IS NULL OR NOT (payload ? 'stock_quantity') THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(payload -> 'stock_quantity') <> 'number' THEN
    RETURN false;
  END IF;
  numeric_value := (payload ->> 'stock_quantity')::numeric;
  RETURN numeric_value >= 0
     AND numeric_value = trunc(numeric_value)
     AND numeric_value <= 9007199254740991;
EXCEPTION
  WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN false;
END
$function$;

CREATE FUNCTION marketplace_inventory_quantity_from_attributes(payload jsonb)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
  IF payload IS NULL OR NOT (payload ? 'stock_quantity') THEN
    RETURN NULL;
  END IF;
  IF NOT marketplace_inventory_stock_is_valid(payload) THEN
    RETURN 0;
  END IF;
  RETURN ((payload ->> 'stock_quantity')::numeric)::bigint;
END
$function$;

CREATE FUNCTION marketplace_inventory_mirror(payload jsonb, quantity bigint)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN quantity IS NULL THEN COALESCE(payload, '{}'::jsonb) - 'stock_quantity'
    ELSE jsonb_set(
      COALESCE(payload, '{}'::jsonb),
      '{stock_quantity}',
      to_jsonb(quantity),
      true
    )
  END
$function$;

ALTER TABLE marketplace_offers
    ADD COLUMN available_quantity bigint,
    ADD COLUMN inventory_version bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT marketplace_offers_available_quantity_check CHECK (
      available_quantity IS NULL
      OR available_quantity BETWEEN 0 AND 9007199254740991
    ),
    ADD CONSTRAINT marketplace_offers_inventory_version_check CHECK (inventory_version > 0);

CREATE TABLE marketplace_inventory_events (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    store_id uuid,
    offer_id uuid NOT NULL,
    reservation_id uuid,
    payment_id uuid,
    platform_path text NOT NULL,
    event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
    previous_quantity bigint CHECK (
      previous_quantity IS NULL OR previous_quantity BETWEEN 0 AND 9007199254740991
    ),
    new_quantity bigint CHECK (
      new_quantity IS NULL OR new_quantity BETWEEN 0 AND 9007199254740991
    ),
    previous_inventory_version bigint CHECK (
      previous_inventory_version IS NULL OR previous_inventory_version > 0
    ),
    new_inventory_version bigint NOT NULL CHECK (new_inventory_version > 0),
    previous_offer_version bigint CHECK (previous_offer_version IS NULL OR previous_offer_version > 0),
    new_offer_version bigint NOT NULL CHECK (new_offer_version > 0),
    actor_kind text NOT NULL CHECK (
      actor_kind IN ('backfill', 'legacy_writer', 'seller', 'buyer', 'payment', 'system', 'host_operator')
    ),
    actor_ref text CHECK (actor_ref IS NULL OR length(actor_ref) BETWEEN 1 AND 200),
    request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 200),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
      jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (platform_path = '/' OR platform_path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$')
);

CREATE INDEX marketplace_inventory_events_offer_time_idx
    ON marketplace_inventory_events (tenant_id, offer_id, created_at DESC);
CREATE INDEX marketplace_inventory_events_reservation_time_idx
    ON marketplace_inventory_events (tenant_id, reservation_id, created_at DESC)
    WHERE reservation_id IS NOT NULL;
CREATE INDEX marketplace_inventory_events_payment_time_idx
    ON marketplace_inventory_events (tenant_id, payment_id, created_at DESC)
    WHERE payment_id IS NOT NULL;

-- Preserve evidence for malformed legacy values without retaining the value itself.
INSERT INTO marketplace_inventory_events (
    tenant_id,
    domain_id,
    store_id,
    offer_id,
    platform_path,
    event_type,
    previous_quantity,
    new_quantity,
    previous_inventory_version,
    new_inventory_version,
    previous_offer_version,
    new_offer_version,
    actor_kind,
    request_id,
    metadata
)
SELECT offer.tenant_id,
       offer.domain_id,
       offer.store_id,
       offer.id,
       COALESCE(alias.path, party.platform_path),
       'marketplace.inventory.backfill_quarantined',
       NULL,
       0,
       NULL,
       1,
       offer.version,
       offer.version,
       'backfill',
       'migration:202608220004',
       jsonb_build_object(
         'legacy_json_type', COALESCE(jsonb_typeof(offer.attributes -> 'stock_quantity'), 'missing'),
         'normalized', true
       )
  FROM marketplace_offers offer
  JOIN marketplace_parties party
    ON party.tenant_id = offer.tenant_id
   AND party.id = offer.supply_party_id
  LEFT JOIN store_path_aliases alias
    ON alias.tenant_id = offer.tenant_id
   AND alias.store_id = offer.store_id
   AND alias.is_canonical
 WHERE offer.attributes ? 'stock_quantity'
   AND NOT marketplace_inventory_stock_is_valid(offer.attributes);

UPDATE marketplace_offers
   SET available_quantity = marketplace_inventory_quantity_from_attributes(attributes),
       attributes = marketplace_inventory_mirror(
         attributes,
         marketplace_inventory_quantity_from_attributes(attributes)
       ),
       inventory_version = 1;

CREATE TABLE marketplace_inventory_reservations (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    tenant_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    store_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    checkout_session_id uuid NOT NULL,
    buyer_subject_hash bytea NOT NULL CHECK (octet_length(buyer_subject_hash) = 32),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 9007199254740991),
    inventory_unbounded boolean NOT NULL,
    status text NOT NULL DEFAULT 'reserved' CHECK (
      status IN ('reserved', 'payment_pending', 'release_pending', 'committed', 'released', 'conflict')
    ),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    unit_amount numeric(30, 0) NOT NULL CHECK (unit_amount >= 0),
    total_amount numeric(30, 0) NOT NULL CHECK (total_amount >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    currency_scale smallint NOT NULL CHECK (currency_scale BETWEEN 0 AND 8),
    offer_version_at_reserve bigint NOT NULL CHECK (offer_version_at_reserve > 0),
    inventory_version_at_reserve bigint NOT NULL CHECK (inventory_version_at_reserve > 0),
    payment_id uuid REFERENCES payment_intents(id) ON DELETE RESTRICT,
    payment_version integer CHECK (payment_version IS NULL OR payment_version > 0),
    merchant_order_id text NOT NULL CHECK (length(merchant_order_id) BETWEEN 1 AND 200),
    expires_at timestamptz NOT NULL,
    reservation_version bigint NOT NULL DEFAULT 1 CHECK (reservation_version > 0),
    release_reason text CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 200),
    reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (
      reconciliation_attempts BETWEEN 0 AND 32
    ),
    reconciliation_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reconciliation_lease_owner text CHECK (
      reconciliation_lease_owner IS NULL OR length(reconciliation_lease_owner) BETWEEN 1 AND 200
    ),
    reconciliation_lease_expires_at timestamptz,
    last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
    last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    committed_at timestamptz,
    released_at timestamptz,
    FOREIGN KEY (tenant_id, domain_id, store_id, offer_id)
        REFERENCES marketplace_offers(tenant_id, domain_id, store_id, id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, checkout_session_id, offer_id),
    UNIQUE (tenant_id, merchant_order_id),
    UNIQUE (payment_id),
    CHECK (total_amount = unit_amount * quantity),
    CHECK (expires_at > created_at),
    CHECK (
      (reconciliation_lease_owner IS NULL AND reconciliation_lease_expires_at IS NULL)
      OR (
        reconciliation_lease_owner IS NOT NULL
        AND reconciliation_lease_expires_at IS NOT NULL
      )
    ),
    CHECK ((status = 'committed') = (committed_at IS NOT NULL)),
    CHECK ((status = 'released') = (released_at IS NOT NULL)),
    CHECK (status <> 'committed' OR payment_id IS NOT NULL),
    CHECK (status NOT IN ('payment_pending', 'release_pending') OR payment_id IS NOT NULL)
);

CREATE INDEX marketplace_inventory_reservations_expiry_idx
    ON marketplace_inventory_reservations (expires_at, created_at)
    WHERE status IN ('reserved', 'payment_pending', 'release_pending');
CREATE INDEX marketplace_inventory_reservations_reconcile_idx
    ON marketplace_inventory_reservations (reconciliation_next_at, created_at)
    WHERE status IN ('reserved', 'payment_pending', 'release_pending');
CREATE INDEX marketplace_inventory_reservations_offer_idx
    ON marketplace_inventory_reservations (tenant_id, offer_id, status, created_at DESC);

CREATE FUNCTION marketplace_inventory_compatibility_write()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  legacy_stock_changed boolean := false;
  canonical_changed boolean := false;
  derived_quantity bigint;
  current_path text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.attributes ? 'stock_quantity' THEN
      NEW.available_quantity := marketplace_inventory_quantity_from_attributes(NEW.attributes);
    END IF;
    NEW.attributes := marketplace_inventory_mirror(NEW.attributes, NEW.available_quantity);
    NEW.inventory_version := 1;
    RETURN NEW;
  END IF;

  canonical_changed := NEW.available_quantity IS DISTINCT FROM OLD.available_quantity;
  legacy_stock_changed := NOT canonical_changed
    AND (
      (NEW.attributes ? 'stock_quantity') IS DISTINCT FROM (OLD.attributes ? 'stock_quantity')
      OR (NEW.attributes -> 'stock_quantity') IS DISTINCT FROM (OLD.attributes -> 'stock_quantity')
    );

  IF canonical_changed THEN
    derived_quantity := NEW.available_quantity;
  ELSIF legacy_stock_changed AND NEW.attributes ? 'stock_quantity' THEN
    derived_quantity := marketplace_inventory_quantity_from_attributes(NEW.attributes);
  ELSE
    derived_quantity := OLD.available_quantity;
  END IF;

  NEW.available_quantity := derived_quantity;
  NEW.attributes := marketplace_inventory_mirror(NEW.attributes, NEW.available_quantity);
  IF NEW.available_quantity IS DISTINCT FROM OLD.available_quantity THEN
    NEW.inventory_version := OLD.inventory_version + 1;
  ELSE
    NEW.inventory_version := OLD.inventory_version;
  END IF;

  IF legacy_stock_changed
     AND NEW.available_quantity IS DISTINCT FROM OLD.available_quantity THEN
    SELECT COALESCE(alias.path, party.platform_path)
      INTO current_path
      FROM marketplace_parties party
      LEFT JOIN store_path_aliases alias
        ON alias.tenant_id = party.tenant_id
       AND alias.store_id = NEW.store_id
       AND alias.is_canonical
     WHERE party.tenant_id = NEW.tenant_id
       AND party.id = NEW.supply_party_id
     LIMIT 1;

    INSERT INTO marketplace_inventory_events (
      tenant_id,
      domain_id,
      store_id,
      offer_id,
      platform_path,
      event_type,
      previous_quantity,
      new_quantity,
      previous_inventory_version,
      new_inventory_version,
      previous_offer_version,
      new_offer_version,
      actor_kind,
      metadata
    ) VALUES (
      NEW.tenant_id,
      NEW.domain_id,
      NEW.store_id,
      NEW.id,
      current_path,
      'marketplace.inventory.legacy_mirrored',
      OLD.available_quantity,
      NEW.available_quantity,
      OLD.inventory_version,
      NEW.inventory_version,
      OLD.version,
      NEW.version,
      'legacy_writer',
      jsonb_build_object('compatibility_trigger', true)
    );
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER marketplace_offers_inventory_compatibility_trigger
BEFORE INSERT OR UPDATE OF attributes, available_quantity, inventory_version
ON marketplace_offers
FOR EACH ROW
EXECUTE FUNCTION marketplace_inventory_compatibility_write();
