# ADR 0016: Layered service architecture

- Status: Accepted
- Date: 2026-08-23

## Context

Gateway and payment-service previously mixed business orchestration, authorization, and persistence inside HTTP handlers and `PgStore` methods. `docs/backend-architecture-refactor.md` defined the target layering but lacked reusable crate boundaries.

## Decision

1. Add `matchplane-http` as a shared interface-layer crate with structured API errors, bearer authentication helpers, and an optional `storage` feature that maps `StorageError` to HTTP errors.
2. Add `matchplane-application` as the application-layer crate with port traits (such as `OrderWriter`) and use cases; the first shipped use case is `OrderService::place_order`.
3. Change the gateway `/v1/orders` path to HTTP parse → `OrderService` → `PgStore` instead of constructing `SubmitOrder` directly in the handler.
4. Extend `matchplane-config::ProviderRegistry` with a builder and listing APIs to prepare for runtime provider loading; the payment `GatewayFactory` remains the reference implementation for payment providers.

## Consequences

- Service adapters can thin out incrementally; marketplace use cases can migrate to the application layer using the same pattern.
- Gateway API errors now use the `{ code, error }` shape aligned with payment-service.
- Follow-up work: centralize marketplace authorization, add backend OAuth/AI admin APIs, and extract remaining business state machines from `matchplane-storage`.

## References

- `docs/backend-refactor-plan.md`
- `ARCHITECTURE.md`
