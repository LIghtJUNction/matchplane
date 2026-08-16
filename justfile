set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := true

default:
    @just --list

web-install:
    bun install --frozen-lockfile --cwd web

web-check: web-install
    bun run --cwd web check

check: web-check agent-check subplatform-check migration-check
    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
    cargo test --workspace --locked

compose-config:
    env_file=.env.example; if [ -f .env ]; then env_file=.env; fi; docker compose --env-file "$env_file" -f deploy/compose/compose.yaml config --quiet

web-image-check:
    docker build --file deploy/compose/web.Dockerfile --tag matchplane/web:check .

agent-check:
    bun test --cwd integrations/matchplane-agent-client
    web/node_modules/.bin/tsc -p integrations/matchplane-agent-client/tsconfig.json --noEmit

dev:
    env_file=.env.example; if [ -f .env ]; then env_file=.env; fi; docker compose --env-file "$env_file" -f deploy/compose/compose.yaml up --build -d

down:
    env_file=.env.example; if [ -f .env ]; then env_file=.env; fi; docker compose --env-file "$env_file" -f deploy/compose/compose.yaml down

migrate:
    cargo run --locked -p xtask -- migrate

smoke:
    ./tests/integration/smoke.sh

package-check:
    ./packaging/scripts/check.sh

subplatform-check:
    test -f .gitmodules
    test -f subplatforms/auto/matchplane.subplatform.json
    python3 -c 'import json; p=json.load(open("subplatforms/auto/package.json")); assert p["scripts"].get("build"), "subplatform package must expose the manifest build command"'
    python3 -c 'import json; m=json.load(open("subplatforms/auto/matchplane.subplatform.json")); a=m["agent"]; assert m["apiVersion"] == "matchplane.subplatform/v1"; assert m["rootApiVersion"] == "v1"; assert m.get("marketplaceContract", "generic-v1") in {"generic-v1", "legacy-v1"}; assert m["slug"] == "used-car"; assert a["protocol"] == "matchplane.agent/v1"; assert set(a["stages"]) == {"merchant", "inventory"}; assert a["skills"] and a["mcpTools"]'
    python3 -c 'import json; json.load(open("docs/agent-mcp-skill-protocol-v1.json")); json.load(open("docs/agent-handoff-protocol-v1.json")); json.load(open("docs/generic-marketplace-contract-v1.json")); json.load(open("docs/platform-routing-protocol-v1.json")); json.load(open("docs/retrieval-protocol-v1.json")); json.load(open("docs/schemas-matchplane-subplatform.json"))'
    test -n "$$(git -C subplatforms/auto rev-parse HEAD)"

migration-check:
    python3 -c 'from pathlib import Path; versions = [p.name.split("_", 1)[0] for p in Path("migrations").glob("[0-9]*_*.sql")]; assert len(versions) == len(set(versions)), f"duplicate migration versions: {[v for v in sorted(set(versions)) if versions.count(v) > 1]}"'
