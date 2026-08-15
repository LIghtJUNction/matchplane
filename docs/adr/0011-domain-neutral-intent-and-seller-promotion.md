# ADR 0011: Domain-neutral matching, consented contact exchange, and seller promotion revenue

## Status

Accepted for the marketplace foundation; the generic intent/offer/introduction kernel is now the
stable path for new verticals, while vehicle APIs remain compatibility adapters during migration.

## Context

MatchPlane's durable value is the negotiation layer between a demand-side participant and a
supply-side participant. A vehicle buyer and seller are one example, not the model itself. After a
successful introduction, the parties may continue on WeChat or by telephone, so a transaction
commission that depends on observing an off-platform sale is not a reliable primary revenue source.

## Decision

1. Both sides use the same `marketplace_parties` identity and capability-token mechanism. The
   vertical supplies labels (`buyer`/`seller`, `requester`/`provider`, or another pair) while the
   matching kernel uses `demand` and `supply` perspectives.
2. A vertical adapts its concrete records to the domain-neutral concepts `MatchIntent`,
   `MarketplaceOffer`, `MatchIntroduction`, and `ContactChannel`. The Rust gateway persists the
   first three through `/v1/marketplace/intents`, `/v1/marketplace/offers`, and
   `/v1/marketplace/introductions`; a match stores its score and reasons at introduction time so
   later model changes cannot rewrite history.
3. Contact exchange is a separate consented state transition. The demand side creates an
   introduction; the supply side explicitly accepts the contact request; only then may either side
   retrieve the other side's allow-listed phone/WeChat fields. The values remain encrypted at rest,
   and every allow/deny decision is audited.
4. The default revenue strategy for off-platform verticals is seller-funded promotion. A supply
   offer may attach a promotion campaign priced as a fixed listing fee, impression fee, click fee,
   or qualified-lead fee. The campaign and billable exposure events are platform-owned records and
   do not require observing the eventual offline transaction.
5. A tenant may additionally enable a disclosed transaction fee or a hybrid policy. This is an
   explicit configuration choice, never a hidden spread in the vehicle or other offer price.
6. Negotiation AI may rank candidates, explain reasons, and propose next actions, but it cannot
   grant contact access or mark a transaction complete. Those remain authenticated, auditable
   state transitions.

## Consequences

- The current automotive `vehicle_listings`, `buyer_vehicle_requests`, and `offline_deals` remain
  compatible adapters. New verticals do not need vehicle-shaped tables or processes; they define
  their own JSON schema/retrieval Agent behind the generic kernel.
- Seller promotion can be charged when exposure is delivered, even if buyer and seller leave the
  platform after exchanging contacts.
- A future dating or services vertical reuses identity, consent, audit, and revenue primitives and
  changes only its schema, copy, ranking features, and safety policy.
- Existing preauthorized transaction-fee tenants keep their policy; the bundled demo market uses
  postpaid contact exchange so the contact flow can be tested without a payment gateway.
