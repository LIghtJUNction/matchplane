# Generic marketplace inventory and reservation contract

## Current rollout state

Production has only the **foundation phase** enabled:

- `marketplace_offers.available_quantity` is the canonical quantity;
- `NULL` means unbounded inventory;
- `0` means finite and sold out;
- `inventory_version` is independent from offer moderation status;
- `marketplace_inventory_reservations` and `marketplace_inventory_events` exist, but no public reserve/adjust/checkout command is enabled;
- no reservation worker is active yet.

This phase is intentionally not advertised as oversell prevention. Checkout remains unavailable in the root Web application until payment reconciliation is complete.

## Canonical/mirror invariant

`attributes.stock_quantity` is a transitional compatibility mirror, never a second authority:

- finite canonical quantity is mirrored as an integer;
- unbounded canonical quantity removes the key;
- malformed legacy values fail closed to `0` and are audited without retaining their original value;
- omitting the key in an old broad update cannot erase existing finite inventory;
- changing the canonical column rewrites the mirror;
- a real quantity change increments `inventory_version`.

A temporary PostgreSQL trigger derives canonical state from legacy attribute-only writers. It must remain until every Gateway/Web writer uses canonical inventory. The later strict phase will reject mirror mismatches instead of deriving them.

## Required serialization point

Every availability mutation starts by locking the same canonical offer row:

```sql
SELECT ...
FROM marketplace_offers
WHERE tenant_id = $1
  AND domain_id = $2
  AND store_id = $3
  AND id = $4
FOR UPDATE;
```

Seller adjustment, reservation, release and payment finalization must share this lock. Valkey, browser state, catalog projections and child retrieval are not inventory locks.

A quantity-changing transaction must atomically:

1. update `available_quantity` and its compatibility mirror;
2. increment `inventory_version` and canonical offer `version`;
3. preserve the offer moderation status;
4. append an inventory audit event;
5. enqueue the existing catalog-v2 projection;
6. commit, or roll back all five changes.

Finite sold-out offers remain `active` but are excluded from discovery. Restocking does not require content moderation. Broad content editing remains separate and still returns an active offer to draft.

## Reservation identity and idempotency

`marketplace_inventory_reservations.id` is the stable idempotency key. The persisted request hash binds:

- tenant/domain/store/offer;
- authenticated checkout session and buyer subject hash;
- quantity;
- canonical price/currency snapshot.

The same ID and same hash returns the original reservation. The same ID with different input is a conflict. Browser-provided seller, amount, currency, source reference, callback authority or payment ID is never authoritative.

## State machine

```text
reserved
  -> payment_pending       payment creation/binding succeeded
  -> released              definitive pre-payment failure/cancel/expiry

payment_pending
  -> committed             canonical payment captured
  -> released              canonical payment failed or voided
  -> release_pending       expiry/cancel requires provider query or void

release_pending
  -> committed             capture won the race
  -> released              provider is definitively noncapturable
  -> release_pending       provider result remains unknown
```

Stock is deducted once at reservation. Commit never deducts again. Release restores finite stock once. Unbounded inventory remains `NULL`. Authorization alone does not commit; refund does not automatically restock. A late capture after confirmed release is an operational conflict, not a silent re-decrement.

## Checkout/payment boundary

The checked root Web source and current production release contain no generic marketplace checkout route. Direct payment authorization exists for bounded payment sources and platform commission, but is not a product-purchase checkout.

Before enabling reservation traffic, MatchPlane must add:

1. a server-only reserve-before-pay checkout route;
2. payment-service validation of `source_type = marketplace_inventory_reservation` and the immutable reservation price/scope snapshot;
3. durable reservation/payment binding in the same PostgreSQL transaction as payment intent insertion;
4. a payment-service-owned reconciliation/expiry worker;
5. wake-up records from every authoritative payment transition: authorize, capture, void, query and verified webhook;
6. locked sold-out checks and concurrency tests;
7. a narrow seller inventory command and MCP tool that have no payment/contact authority.

A timeout is not a definitive payment failure. Bound inventory cannot be released until the provider is known to be noncapturable. Gateways without reliable query/void support cannot participate in inventory-backed checkout.

## Rolling deployment

1. Foundation schema/backfill/compatibility trigger — **complete**.
2. Deploy canonical readers and dual writers while adjustment/reservation remain disabled.
3. Add payment binding and reconciliation jobs; run the worker in dark mode.
4. Drain old writers, validate mirror constraints, then enable strict mode.
5. Enable seller adjustment for a canary store.
6. Enable one-store checkout only after finite-one-unit concurrency and payment failure/recovery tests pass.
7. Rollback disables new adjustment/checkout intake but keeps the finalizer running until every reservation is terminal.
