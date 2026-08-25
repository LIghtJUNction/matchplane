# AI Provider Contract

MatchPlane's root platform uses one server-side provider configuration for its hosted router. Provider credentials remain in protected server storage and are never sent to the browser, child platforms, external agents, or logs.

The configuration contract supports exactly three wire protocols:

- `openai-compatible`
- `anthropic-messages`
- `gemini-generate-content`

No endpoint, model, or vendor is mandatory. A TokenRhythm/DeepSeek OpenAI-compatible deployment is valid, as are the official Anthropic and Gemini API roots when paired with their respective protocols.

## Effective configuration

A configuration is AI-ready only when all of the following are true:

1. The protocol is one of the three known values above.
2. The model ID is a nonempty, at-most-256-character provider identifier: it starts with an ASCII letter or digit and otherwise uses only ASCII letters, digits, `.`, `_`, `-`, `/`, or `:`. Gemini model IDs additionally reject `/` and `:` because they are inserted into the native model path.
3. The endpoint is HTTPS, has no userinfo, query, or fragment, and is otherwise accepted by the public-endpoint safety checks.
4. A server-side credential is configured.
5. The configuration is enabled.
6. If an origin allowlist is configured, the endpoint's exact origin is allowed.

The rootSuperAdmin WebUI managed state is authoritative whenever managed state exists. This remains true when the managed configuration is disabled, incomplete, or unreadable: MatchPlane fails closed instead of silently falling back to environment credentials. Environment endpoint/model/protocol differences are reported as non-secret informational conflicts.

`MATCHPLANE_ROUTER_AI_*` is an operational fallback only when no managed state exists. Browser-safe status responses may report the effective source, endpoint origin, model, protocol, credential presence, policy issues, conflicts, and `originAllowlistApplied`. They never report a required provider tuple, API key, fingerprint, credential file, or provider response body.

## Optional origin allowlist

`MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS` is an optional comma-separated list of exact HTTPS origins:

```dotenv
MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS=https://api.anthropic.com,https://generativelanguage.googleapis.com
```

Each entry must contain only a scheme, host, and optional port. Paths, queries, fragments, userinfo, empty entries, and non-HTTPS origins are invalid and fail closed. An empty or unset variable permits any public HTTPS origin; runtime DNS and transport safety checks still apply.

The allowlist applies equally to managed and environment configurations. Status reports only whether the allowlist is applied, not its entries.

## Manual model configuration

There is no official portable model-list API shared by the three protocols or by OpenAI-compatible providers. Administrators must copy the exact model ID from their provider's documentation and test it before activation.

The WebUI therefore uses a required manual model input and protocol-specific guidance. It does not offer a model dropdown or contact a provider to discover models. `POST /api/platform/ai/models` remains for one compatibility release as an authenticated rootSuperAdmin-only tombstone; it returns HTTP `410` with code `manual_model_configuration_required` and never contacts a provider.

Examples:

```dotenv
# TokenRhythm / DeepSeek through an OpenAI-compatible endpoint
MATCHPLANE_ROUTER_AI_URL=https://tokenrhythm.studio
MATCHPLANE_ROUTER_AI_MODEL=deepseek-v4-flash-0731
MATCHPLANE_ROUTER_AI_PROTOCOL=openai-compatible

# Official Anthropic root
MATCHPLANE_ROUTER_AI_URL=https://api.anthropic.com
MATCHPLANE_ROUTER_AI_MODEL=claude-sonnet-4-6
MATCHPLANE_ROUTER_AI_PROTOCOL=anthropic-messages

# Official Gemini root
MATCHPLANE_ROUTER_AI_URL=https://generativelanguage.googleapis.com
MATCHPLANE_ROUTER_AI_MODEL=gemini-2.5-flash
MATCHPLANE_ROUTER_AI_PROTOCOL=gemini-generate-content
```

Model availability and identifiers change over time; these examples illustrate contract shape, not a guaranteed catalogue.

## Managed lifecycle and secrets

The WebUI lifecycle is: **save candidate → server-side connection test → explicit atomic activation**. Saving or testing a candidate never replaces the active configuration. Only a ready test attestation enables activation.

The API key field is write-only. Leaving it empty retains the protected candidate/active key when allowed by the lifecycle; reads return only `credentialConfigured`. The stored generation schema and versioned credential reference remain unchanged.

Configuration audit records may contain actor, time, endpoint origin, model, protocol, enabled state, key-changed state, and request ID. They must not contain keys, fingerprints, provider response bodies, private user text, or contact details.

External buyer and seller agents choose and pay for their own models. They use the bounded `matchplane.agent/v1` handoff, platform MCP tools, and short-lived capabilities; they never share the root platform provider key.
