# Platform settings

The platform upgrade uses configuration-driven providers.

## Authentication

Authentication capability discovery stays separate from OAuth provider configuration. The existing
server endpoint advertises only server-validated capabilities:

- Password
- Email OTP
- Phone OTP
- Magic link
- Passkey
- National identity
- WeChat
- QQ
- Alipay
- Google
- Generic OAuth2

OAuth records live only in a server-only module. A record contains a stable provider ID, display
name, client ID, secret reference (`env://` or `file://`), scopes, and either an HTTPS discovery URL
or complete HTTPS authorization/token/user-info endpoints. Browser payloads expose only the
server-validated provider ID and display name; they never contain client IDs, endpoint URLs, secret
references, or raw secrets. An incomplete or disabled provider is not advertised to the login UI.

## AI providers

AI records live only in the server configuration boundary and contain:

- Stable provider ID and display name
- HTTPS API endpoint and model name
- Explicit wire protocol (`openai-compatible`, `anthropic-messages`, or `gemini-generate-content`)
- Secret reference, never a raw API key
- Enabled state and optional default provider ID

The public UI may show only the enabled display name/model after server validation. Administrator
write APIs must require a root role, validate the complete server contract, resolve secret
references only on the server, and write an audit event. The current PR defines the DTO boundary;
the actual administrator forms and persistence remain separate work under #15.
