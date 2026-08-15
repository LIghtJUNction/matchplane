# Operator contract

The packaged CLI commands are designed for automation:

| Command | Purpose | Mutation |
| --- | --- | --- |
| `matchplane doctor --json` | Validate loaded configuration and dependency gates | none |
| `matchplane status --json` | Probe gateway, payment, and web readiness endpoints | none |
| `matchplane migrate` | Apply embedded PostgreSQL migrations | schema |
| `matchplane initialize` | Migrate; demo data only with explicit opt-in outside production | schema/data |
| `matchplane serve <service>` | Start one named workload under a supervisor | process |
| `matchplane mcp serve` | Run the read-only stdio MCP operations server | none |

JSON output is stable enough for an operations Agent: it contains `ok`, `service`, `url`, and
`error` fields, never connection strings, tokens, passwords, or provider credentials. Exit code 0
means all requested checks passed; non-zero means the caller must surface the failure.
