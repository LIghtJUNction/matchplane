# Platform settings

The platform upgrade uses configuration-driven providers.

## Authentication

Authentication providers are represented as providers instead of hardcoded routes.
Supported provider types:

- Phone
- Email
- WeChat
- QQ
- Alipay
- Google
- Generic OAuth2

Each provider stores only configuration metadata. Secrets should be encrypted by the backend before persistence.

## AI providers

AI configuration contains:

- Provider type
- API endpoint
- Model name
- Enabled state

The UI should expose these settings through an administrator-only settings workspace.
