# ADR 0015: Flat marketplace and stores

## Status

Accepted

## Context

Recursive “platform inside platform” terminology made ordinary commerce tasks look like
infrastructure administration. A shopper needs one marketplace, many stores, comparable products,
and one assistant. A merchant needs one stable store identity whether its catalog is hosted by
MatchPlane, delivered as a package, or connected from an external service.

Existing organizations, paths, registrations, audit records, and v1 integration contracts cannot
be rewritten safely. They still provide useful authorization and compatibility data, but they are
not the product hierarchy.

## Decision

1. The public product has exactly two layers: one marketplace and a flat directory of stores.
   Stores cannot contain other stores. New registrations are attached to the canonical root by the
   server; callers cannot choose an arbitrary parent.
2. `stores.id` is the stable commercial identity. Package registrations and federation bindings
   are versioned integration records referenced by a store, not store identities themselves.
3. Every store has one canonical one-segment public path and may retain legacy aliases. Historical
   organization paths remain valid compatibility scope tokens and audit data; new APIs use store
   IDs as authority and never infer ownership from a leaf slug.
4. Domains remain internal catalog/schema scopes. They are not shown as another marketplace level.
   Offers and marketplace parties acquire `store_id`; product external keys are unique within a
   store rather than across unrelated stores.
5. Public discovery reads only active offers from active public stores. The server may use AI to
   select a bounded set of stores, but it re-reads canonical product name, description, image,
   price, currency, lifecycle, and store ownership from PostgreSQL before returning results.
   Contact data, credentials, unpublished offers, internal tenant/domain IDs, and remote tool
   output never become public catalog fields.
6. Guests may browse stores, search, compare, and use bounded shopping assistance. Authentication
   begins when a user saves, contacts, buys, opens a store, or publishes a product. Buyer and seller
   are actions of one account, not account types.
7. Hosted, package, and external integrations all project to the same store contract. External
   retrieval is advisory; canonical state, consent, payment, commercial terms, and audit remain
   marketplace-owned.
8. Merchant charges are explicit store commercial terms: subscription, commission, or a disclosed
   hybrid. Sponsored exposure must be labelled and cannot silently replace organic ranking.
9. Better Auth role strings remain stable internally. User-facing copy uses business terms such as
   商城负责人、商城运营、店主、店铺运营 and 店铺成员.

## Consequences

- The mall route makes one bounded store-selection decision and one canonical catalog query; it no
  longer recursively fans out through a browser-visible topology.
- Old recursive APIs and paths can remain adapters while new writes and UI stay flat.
- Multiple stores may use the same SKU, while duplicates inside one store remain conflicts.
- A distributed merchant keeps its own catalog and tools without becoming another nested
  marketplace in this deployment.
- Removing the compatibility tree is a later migration, not a prerequisite for the simpler product.
