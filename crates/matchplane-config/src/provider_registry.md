# Provider Registry

The backend uses a provider registry boundary.

Goals:

- Keep business services independent from vendors.
- Allow administrators to enable or disable providers.
- Share the same model between OAuth, AI, payment and notification systems.

Provider lifecycle:

1. Load configuration.
2. Validate provider definition.
3. Register provider.
4. Application services query enabled providers.

The registry intentionally does not contain provider implementation logic. Concrete integrations remain isolated in their own crates.
