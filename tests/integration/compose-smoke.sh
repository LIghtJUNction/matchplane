#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Keep every captured response under the repository scratch tree; never use /tmp.
source "$repository_root/tests/integration/http-json.sh"
http_json_root=${MATCHPLANE_SMOKE_TMPDIR:-$repository_root/.scratch/ci-smoke}
mkdir -p "$http_json_root"
HTTP_JSON_WORK_DIRECTORY=$(mktemp -d "$http_json_root/compose-http-json.XXXXXX")
export HTTP_JSON_WORK_DIRECTORY
env_file="$repository_root/.env.example"
if [[ -f "$repository_root/.env" ]]; then env_file="$repository_root/.env"; fi
compose=(docker compose --env-file "$env_file" -f "$repository_root/deploy/compose/compose.yaml")

# The smoke stack is disposable. Always remove its containers, network, and volumes when the
# test exits, including assertion failures, so a local or CI interruption cannot leave Kafka and
# the other workload containers consuming CPU and disk indefinitely.
cleanup() {
  local status=$?
  local log_path
  trap - EXIT
  if ((status != 0)); then
    log_path=${MATCHPLANE_COMPOSE_LOG_PATH:-$repository_root/compose.log}
    mkdir -p "$(dirname "$log_path")"
    {
      printf '== compose ps ==\n'
      "${compose[@]}" ps --all
      printf '\n== compose logs ==\n'
      "${compose[@]}" logs --no-color
    } >"$log_path" 2>&1 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$HTTP_JSON_WORK_DIRECTORY"
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up --build --detach --wait
"${compose[@]}" exec -T postgres psql \
  --username "${MATCHPLANE_POSTGRES_USER:-matchplane}" \
  --dbname "${MATCHPLANE_POSTGRES_DB:-matchplane}" \
  <"$repository_root/tests/integration/fixture.sql" >/dev/null
web_base=${MATCHPLANE_WEB_BASE_URL:-http://127.0.0.1:${MATCHPLANE_WEB_HOST_PORT:-4173}}
http_json_pipe "$web_base/api/health/web" --location |
  jq -e '.status == "ok" and .service == "matchplane-web"' >/dev/null
auth_response="$HTTP_JSON_WORK_DIRECTORY/web-auth.json"
http_json_expect_status 401 "$auth_response" \
  "$web_base/api/platform/api-keys?organizationId=00000000-0000-0000-0000-000000000001" --location
jq -e 'type == "object"' "$auth_response" >/dev/null
"$repository_root/tests/integration/smoke.sh"
