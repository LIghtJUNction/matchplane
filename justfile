set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := true

default:
    @just --list

web-install:
    bun install --frozen-lockfile --cwd web

web-check: web-install
    bun run --cwd web check

check: web-check agent-check subplatform-check migration-check skills-check
    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
    cargo test --workspace --locked

compose-config:
    env_file=.env.example; if [ -f .env ]; then env_file=.env; fi; docker compose --env-file "$env_file" -f deploy/compose/compose.yaml config --quiet

web-image-check:
    docker build --file deploy/compose/web.Dockerfile --tag matchplane/web:check .

agent-check:
    bun run --cwd integrations/matchplane-agent-client build
    bun test --cwd integrations/matchplane-agent-client
    web/node_modules/.bin/tsc -p integrations/matchplane-agent-client/tsconfig.json --noEmit
    cd integrations/matchplane-agent-client && npm pack --dry-run --ignore-scripts --json >/dev/null

dev:
    env_file=.env.example; if [ -f .env ]; then env_file=.env; fi; docker compose --env-file "$env_file" -f deploy/compose/compose.yaml up --build -d

down:
    env_file=.env.example; if [ -f .env ]; then env_file=.env; fi; docker compose --env-file "$env_file" -f deploy/compose/compose.yaml down

migrate:
    cargo run --locked -p xtask -- migrate

doctor:
    cargo run --locked -p xtask -- doctor --json

provider-preflight:
    cargo run --locked -p xtask -- provider-preflight --json

smoke:
    ./tests/integration/smoke.sh

package-check:
    ./packaging/scripts/check.sh

subplatform-check:
    python3 -c 'import json; json.load(open("docs/agent-mcp-skill-protocol-v1.json")); json.load(open("docs/agent-handoff-protocol-v1.json")); json.load(open("docs/catalog-protocol-v1.json")); json.load(open("docs/federation-enrollment-protocol-v1.json")); json.load(open("docs/generic-marketplace-contract-v1.json")); json.load(open("docs/media-attachment-protocol-v1.json")); json.load(open("docs/platform-routing-protocol-v1.json")); json.load(open("docs/retrieval-protocol-v1.json")); json.load(open("docs/schemas-matchplane-subplatform.json"))'

# Validate an independently checked-out store package without coupling it to the core repository.
subplatform-package-check path:
    test -f "{{path}}/matchplane.subplatform.json"
    python3 -c 'import json, sys; p=json.load(open(sys.argv[1])); assert p["scripts"].get("build"), "subplatform package must expose the manifest build command"' "{{path}}/package.json"
    python3 -c 'import json, re, sys; m=json.load(open(sys.argv[1])); a=m["agent"]; assert m["apiVersion"] == "matchplane.subplatform/v1"; assert m["rootApiVersion"] == "v1"; assert m.get("marketplaceContract", "generic-v1") in {"generic-v1", "legacy-v1"}; assert isinstance(m["slug"], str) and m["slug"] and m["slug"] != "root"; assert a["protocol"] == "matchplane.agent/v1"; assert a["stages"] and all(re.fullmatch(r"[a-z0-9][a-z0-9._:-]{1,127}", stage) for stage in a["stages"]); assert a["skills"] and isinstance(a["mcpTools"], list)' "{{path}}/matchplane.subplatform.json"

subplatform-package-build-check path:
    just subplatform-package-check "{{path}}"
    bun install --no-save --cwd "{{path}}"
    bun run --cwd "{{path}}" build
    bun run --cwd "{{path}}" agent:test
    test -s "{{path}}/dist/index.html"

migration-check:
    python3 -c 'from pathlib import Path; versions = [p.name.split("_", 1)[0] for p in Path("migrations").glob("[0-9]*_*.sql")]; assert len(versions) == len(set(versions)), f"duplicate migration versions: {[v for v in sorted(set(versions)) if versions.count(v) > 1]}"'

skills-check:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tools/test_check_skills.py
    PYTHONDONTWRITEBYTECODE=1 python3 tools/check-skills.py
