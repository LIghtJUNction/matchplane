#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose=(docker compose --env-file "$repository_root/.env.example" -f "$repository_root/deploy/compose/compose.yaml")

"${compose[@]}" up --build --detach --wait
"$repository_root/tests/integration/smoke.sh"
