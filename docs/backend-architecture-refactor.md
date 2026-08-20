# Backend architecture refactor

## Target

Production-ready backend structure for MatchPlane.

## Layers

- Domain layer: entities, rules, invariants.
- Application layer: workflows and orchestration.
- Infrastructure layer: PostgreSQL, Kafka, Valkey and external services.
- Interface layer: HTTP, gRPC and MCP adapters.

## Provider registry

All external capabilities should use registries:

- authentication
- OAuth
- AI models
- payments
- notifications

Configuration changes should not require recompiling core services.

## Security

- centralized authorization
- encrypted secrets
- audit events
- startup validation
- consistent API errors

## Migration

1. extract application services
2. introduce provider registry
3. create admin configuration APIs
4. migrate integrations
5. add integration tests
