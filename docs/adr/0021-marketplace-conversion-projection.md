# ADR 0021: Conversion facts and store-customer projection

- Status: Accepted
- Date: 2026-08-24

## Context

`marketplace-v1` sales handoffs intentionally store a domain-scoped, non-contact snapshot with an
opaque bounded `summary`. Coupling that generic write to Web `stores`, Better Auth `member`, or
`user_notifications` would break root-path and non-store clients, turn vertical fields into kernel
schema, and make browser orchestration responsible for reliability.

The authoritative direct-contact action already exists: a demand party transitions a generic
introduction by writing an allowed `contact_requested` fact in the same serializable transaction.
A store notification created later by the browser can be lost after that commit.

## Decision

1. `marketplace_introduction_contact_events` remains the authority for contact request, consent, and
   release facts. A direct buyer contact flow does not create a second sales handoff.
2. `marketplace_sales_handoffs` remains the generic, domain-neutral record for an AI-to-human
   handoff that has not requested contact exchange. Its v1 opaque-summary contract remains
   backward compatible. The application layer requires demand capability.
3. Database triggers atomically append both new contact facts and new sales handoffs to
   `marketplace_conversion_outbox`. Outbox rows contain only authority IDs, event type, tenant,
   claim state, and audit metadata; they contain no contact value, model summary, or Web schema.
4. A separate customer-projection/notification consumer will claim this outbox, resolve canonical
   introduction/offer/store authority, and idempotently project stable store customers, individual
   opportunities, actionable in-app notifications, and later external notification jobs.
5. The projector—not the browser—owns retry, recipient resolution, deep links, and status sync.
   Contact-request notifications link to the authoritative introduction. AI handoff notifications
   link to the opportunity but never imply contact consent.
6. The migration does not backfill or notify historical rows. Any future replay requires a dry run,
   bounded eligibility rules, operator approval, and an append-only audit.

## Consequences

- A committed `contact_requested` fact always has a durable projection job, eliminating the
  contact-succeeded/notification-missed browser window.
- Generic MCP, root `/`, and non-automotive handoff clients retain the v1 opaque contract.
- Notification delivery is not complete until the separate projector is deployed; outbox backlog
  must be visible as degraded health rather than silently treated as success.
- The consumer must deduplicate by `(source_type, source_id)` and must never read untrusted summary
  text as instructions or contact data.

## Rollback

The outbox table and triggers are additive. Removing the triggers stops new projection jobs without
changing authoritative introduction or handoff records. Existing pending rows remain auditable and
must not be silently deleted.
