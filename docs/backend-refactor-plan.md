# Backend Production Refactor Plan

## Goals

Refactor the backend into clearer production boundaries without changing domain guarantees.

## Service boundaries

- API layer: HTTP/gRPC transport only.
- Application layer: use cases, authorization, orchestration.
- Domain layer: marketplace rules and invariants.
- Infrastructure layer: PostgreSQL, Kafka, Valkey, external providers.

## Required improvements

- Centralized authentication and authorization middleware.
- Provider registry for OAuth and AI model integrations.
- Explicit admin configuration services.
- Audit events for security-sensitive operations.
- Consistent error model across services.
- Health/readiness checks separated from business APIs.
- Dependency injection for external integrations.

## Migration order

1. Extract application services.
2. Move configuration access behind interfaces.
3. Introduce provider registries.
4. Add admin configuration APIs.
5. Add integration tests.
