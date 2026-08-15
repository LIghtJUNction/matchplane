# MatchPlane CLI and MCP operations

The packaged `matchplane` executable is the operator boundary for backend workloads. It keeps
service selection explicit and lets systemd, Compose, Helm, or an operations Agent use the same
entrypoint:

```sh
matchplane doctor --json
matchplane status --json
matchplane migrate
matchplane serve gateway
matchplane mcp serve
```

`serve` starts only a named packaged workload and forwards its environment and standard streams.
The web workload uses `MATCHPLANE_WEB_NODE` and `MATCHPLANE_WEB_SERVER` when the defaults (`node`
and `/usr/share/matchplane/web/server.js`) are not suitable. Supervisors remain responsible for
users, resource limits, restart policy, and signal/termination policy.

## MCP stdio contract

`matchplane mcp serve` implements newline-delimited JSON-RPC for MCP clients. It supports
`initialize`, `tools/list`, and `tools/call` for three read-only tools:

- `platform.status` — probes gateway, payment, and web readiness URLs;
- `platform.health` — the same bounded health report for simple clients;
- `platform.doctor` — validates the loaded `MATCHPLANE_*` configuration and production gates.

The URLs are operator configuration (`MATCHPLANE_GATEWAY_HEALTH_URL`,
`MATCHPLANE_PAYMENT_HEALTH_URL`, and `MATCHPLANE_WEB_HEALTH_URL`) and default to loopback. Output
contains status codes and redacted errors, never credentials or connection strings. The server does
not expose shell execution, arbitrary HTTP forwarding, database writes, payment actions, or contact
data. Platform matching and subplatform retrieval remain behind their authenticated HTTP/MCP
contracts and are not granted by this operations server. The web service exposes the authenticated
HTTP MCP facade at `/api/mcp`; its `platform.match` tool forwards the same bounded route request as
the chat API and accepts either a Better Auth session or a scoped organization API key. The
`platform.agent.handoff` tool accepts the caller-funded `matchplane.agent/v1` envelope, persists an
idempotent handoff, and returns only the active direct-child capabilities. It never invokes the
root model: an external buyer/seller Agent keeps its own provider credentials and token bill. Use
an organization API key with the explicit `agent:handoff` permission for machine calls.

For a machine buyer or seller to continue into the generic marketplace tools, create an
organization API key with `marketplace:write` and API-key metadata `agentRole: buyer`, `seller`, or
`both`. Call `marketplace.agent.session` through `/api/mcp` (or
`POST /api/marketplace/agent-session`) with the active `tenant_id`, `domain_id`, `platform_path`,
and role. The response is a tenant/role-scoped short-lived party bearer. Pass that bearer as
`Authorization: Bearer ...` to the `marketplace.intent.*`, `marketplace.offer.*`, and
`marketplace.introduction.*` tools. The exchange does not create a browser session, accept a
caller-selected participant ID, or expose contact values.

Exit code is non-zero when a doctor check or any readiness probe fails. This makes the CLI suitable
for CI, systemd preflight, and an Agent's bounded tool loop.
