#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose=(docker compose --env-file "$repository_root/.env.example" -f "$repository_root/deploy/compose/compose.yaml")

"${compose[@]}" up --build --detach --wait
"${compose[@]}" exec -T postgres psql \
  --username "${MATCHPLANE_POSTGRES_USER:-matchplane}" \
  --dbname "${MATCHPLANE_POSTGRES_DB:-matchplane}" \
  < "$repository_root/tests/integration/fixture.sql" >/dev/null
web_base=${MATCHPLANE_WEB_BASE_URL:-http://127.0.0.1:${MATCHPLANE_WEB_HOST_PORT:-4173}}
curl --fail --silent --show-error --location "$web_base/api/health/web" \
  | jq -e '.status == "ok" and .service == "matchplane-web"' >/dev/null
auth_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --location "$web_base/api/platform/api-keys?organizationId=00000000-0000-0000-0000-000000000001")
test "$auth_status" = 401
"$repository_root/tests/integration/smoke.sh"
