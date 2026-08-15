---
name: matchplane-operations
description: Operate MatchPlane safely through its unified CLI and read-only MCP tools. Use when starting a backend service, checking production configuration, diagnosing health, validating mounts, or assisting an operations agent during deployment.
---

# MatchPlane Operations

Prefer the packaged `matchplane` CLI for operator and agent actions. Keep mutating actions
explicit, authenticated, and auditable; the MCP surface is read-only by default.

## Safe operating sequence

1. Run `matchplane doctor --json` and fix configuration errors before starting workloads.
2. Run `matchplane status --json` to check gateway, payment, and web health endpoints. Treat a
   failed readiness check as an operational incident, not as a reason to bypass auth or TLS.
3. Apply schema changes with `matchplane migrate`; only use `matchplane bootstrap` in a deliberately
   opted-in development/test environment.
4. Start one workload with `matchplane serve <service>` under systemd/container supervision. Do
   not run services as root or pass secrets on the command line.
5. For an operations agent, start `matchplane mcp serve` over stdio. Expose only
   `platform.status`, `platform.doctor`, and `platform.health`; never add a tool that executes
   arbitrary shell commands or returns secret values.

## Production gates

Production requires unique Better Auth and service secrets, HTTPS origins, PostgreSQL
`sslmode=verify-full`, `rediss://` Valkey, Kafka mTLS for Kafka workloads, and an explicitly
configured payment/AI provider. A path is routable only after every ancestor registration and the
target immutable registration are `active`.

See [references/operator-contract.md](references/operator-contract.md) for exit codes, JSON output,
and the deployment checklist.
