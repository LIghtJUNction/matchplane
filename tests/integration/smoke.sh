#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$repository_root/tests/integration/http-json.sh"
http_json_root=${MATCHPLANE_SMOKE_TMPDIR:-$repository_root/.scratch/ci-smoke}
mkdir -p "$http_json_root"
HTTP_JSON_WORK_DIRECTORY=$(mktemp -d "$http_json_root/http-json.XXXXXX")
export HTTP_JSON_WORK_DIRECTORY
export -f http_json http_json_pipe
env_file="$repository_root/.env.example"
if [[ -f "$repository_root/.env" ]]; then env_file="$repository_root/.env"; fi
compose=(docker compose --env-file "$env_file" -f "$repository_root/deploy/compose/compose.yaml")
base_url=${MATCHPLANE_BASE_URL:-http://127.0.0.1:8080}
core_authorization='authorization: Bearer matchplane-development-gateway-admin'
market_id=00000000-0000-7000-8000-000000000301
tenant_id=00000000-0000-7000-8000-000000000100
domain_id=00000000-0000-7000-8000-000000000101
asset_id=00000000-0000-7000-8000-000000000601
model_id=00000000-0000-7000-8000-000000000701
buyer_quote=00000000-0000-7000-8000-000000000501
buyer_base=00000000-0000-7000-8000-000000000502
seller_base=00000000-0000-7000-8000-000000000503
seller_quote=00000000-0000-7000-8000-000000000504
work_directory=$(mktemp -d "$http_json_root/orders.XXXXXX")
trap 'rm -rf "$HTTP_JSON_WORK_DIRECTORY" "$work_directory"' EXIT

wait_for() {
  local description=$1
  local request_target=$2
  local jq_filter=$3
  shift 3
  local response_file="$HTTP_JSON_WORK_DIRECTORY/wait.json"

  for _ in $(seq 1 90); do
    if http_json "$response_file" "$request_target" "$@" 2>/dev/null \
      && jq -e "$jq_filter" "$response_file" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for $description: $request_target (HTTP ${HTTP_JSON_LAST_STATUS:-unknown}; content-type ${HTTP_JSON_LAST_CONTENT_TYPE:-unknown})" >&2
  return 1
}

wait_for 'gateway readiness' "$base_url/health/ready" '.status == "ready"'

unauthenticated_core=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'content-type: application/json' \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"asset_id\":\"$asset_id\",\"embedding_model_id\":\"$model_id\",\"values\":[0.1,0.2,0.3]}" \
  "$base_url/v1/embeddings")
test "$unauthenticated_core" = 401

curl --fail-with-body --silent --request POST "$base_url/v1/embeddings" \
  --header "$core_authorization" --header 'content-type: application/json' \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"asset_id\":\"$asset_id\",\"embedding_model_id\":\"$model_id\",\"values\":[0.1,0.2,0.3]}"
http_json_pipe "$base_url/v1/candidates/search" \
  --request POST --header "$core_authorization" --header 'content-type: application/json' \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"embedding_model_id\":\"$model_id\",\"values\":[0.1,0.2,0.3],\"limit\":5}" \
  | jq -e --arg asset "$asset_id" 'length == 1 and .[0].asset_id == $asset' >/dev/null

seller_request="$work_directory/seller.json"
buyer_one_request="$work_directory/buyer-one.json"
buyer_two_request="$work_directory/buyer-two.json"
printf '%s\n' "{\"order_id\":\"00000000-0000-7000-8000-000000008001\",\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"market_id\":\"$market_id\",\"side\":\"sell\",\"price\":\"100\",\"quantity\":\"5\",\"idempotency_key\":\"smoke-seller-v1\",\"reservation_account_id\":\"$seller_base\",\"settlement_account_id\":\"$seller_quote\",\"submitted_at\":\"2026-08-14T01:00:00Z\"}" >"$seller_request"
printf '%s\n' "{\"order_id\":\"00000000-0000-7000-8000-000000008002\",\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"market_id\":\"$market_id\",\"side\":\"buy\",\"price\":\"110\",\"quantity\":\"3\",\"idempotency_key\":\"smoke-buyer-one-v1\",\"reservation_account_id\":\"$buyer_quote\",\"settlement_account_id\":\"$buyer_base\",\"submitted_at\":\"2026-08-14T01:00:01Z\"}" >"$buyer_one_request"
printf '%s\n' "{\"order_id\":\"00000000-0000-7000-8000-000000008003\",\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"market_id\":\"$market_id\",\"side\":\"buy\",\"price\":\"110\",\"quantity\":\"2\",\"idempotency_key\":\"smoke-buyer-two-v1\",\"reservation_account_id\":\"$buyer_quote\",\"settlement_account_id\":\"$buyer_base\",\"submitted_at\":\"2026-08-14T01:00:02Z\"}" >"$buyer_two_request"

http_json_pipe "$base_url/v1/orders" \
  --request POST --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$seller_request" \
  | jq -e '.duplicate == false' >/dev/null
wait_for 'seller order admission' "$base_url/v1/orders/00000000-0000-7000-8000-000000008001" '.status == "open"' --header "$core_authorization"

http_json_pipe "$base_url/v1/orders" \
  --request POST --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$buyer_one_request" \
  | jq -e '.duplicate == false' >/dev/null
http_json_pipe "$base_url/v1/orders" \
  --request POST --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$buyer_one_request" \
  | jq -e '.duplicate == true' >/dev/null
wait_for 'first deterministic trade' "$base_url/v1/markets/$market_id/trades" 'length == 1 and .[0].price == "100" and .[0].quantity == "3"' --header "$core_authorization"
wait_for 'first projected book' "$base_url/v1/markets/$market_id/book" '.sequence == 2 and (.asks | length) == 1 and .asks[0].price == "100" and .asks[0].quantity == "2"' --header "$core_authorization"

conflict_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST "$base_url/v1/orders" \
  --header "$core_authorization" --header 'content-type: application/json' \
  --data "$(sed 's/\"quantity\":\"3\"/\"quantity\":\"4\"/' "$buyer_one_request")")
test "$conflict_status" = 409

"${compose[@]}" restart matcher >/dev/null
http_json_pipe "$base_url/v1/orders" \
  --request POST --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$buyer_two_request" \
  | jq -e '.duplicate == false' >/dev/null
wait_for 'post-restart snapshot recovery and trade' "$base_url/v1/markets/$market_id/trades" 'length == 2' --header "$core_authorization"
wait_for 'empty projected book after second fill' "$base_url/v1/markets/$market_id/book" '.sequence == 3 and (.bids | length) == 0 and (.asks | length) == 0' --header "$core_authorization"

database_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane --tuples-only --no-align --command \
  "SELECT (SELECT count(*) FROM orders), (SELECT count(*) FROM trades), (SELECT count(*) FROM ledger_entries), (SELECT count(*) FROM consumer_inbox WHERE status='applied'), (SELECT count(*) FROM asset_embeddings), (SELECT available_amount::text FROM accounts WHERE id='00000000-0000-7000-8000-000000000505');")
test "$database_assertion" = '3|2|10|3|1|5'

extension_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane --tuples-only --no-align --command \
  "SELECT extname || '=' || extversion FROM pg_extension WHERE extname IN ('timescaledb','vector') ORDER BY extname;")
printf '%s\n' "$extension_assertion" | grep -Fx 'timescaledb=2.29.1' >/dev/null
printf '%s\n' "$extension_assertion" | grep -Fx 'vector=0.8.6' >/dev/null

webhook_claim_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT count(*) FROM information_schema.columns \
   WHERE table_name = 'payment_webhook_inbox' \
     AND column_name IN ('processing_at', 'processing_token');")
test "$webhook_claim_assertion" = 2

invoice_admin_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT (SELECT count(*) FROM information_schema.tables \
             WHERE table_name = 'invoice_config_audit'), \
          (SELECT count(*) FROM information_schema.tables \
             WHERE table_name = 'invoice_mode_audit'), \
          (SELECT count(*) FROM invoice_settings \
             WHERE tenant_id = '$tenant_id' AND active_mode = 'test');")
test "$invoice_admin_assertion" = '1|1|1'

gateway_pin_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT count(*) FROM information_schema.columns \
   WHERE table_name = 'payment_intents' \
     AND column_name IN ('gateway_config_version', 'gateway_credential_secret_ref', \
                         'gateway_credential_digest');")
test "$gateway_pin_assertion" = 3

gateway_digest_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT count(*) FROM information_schema.columns \
   WHERE table_name = 'payment_gateway_configs' AND column_name = 'credential_secret_digest';")
test "$gateway_digest_assertion" = 1

invoice_digest_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT (SELECT count(*) FROM information_schema.columns \
             WHERE table_name = 'invoice_provider_configs' \
               AND column_name = 'credential_secret_digest'), \
          (SELECT count(*) FROM information_schema.columns \
             WHERE table_name = 'invoice_requests' \
               AND column_name = 'provider_credential_digest');")
test "$invoice_digest_assertion" = '1|1'

marketplace_authorization_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT count(*) FROM information_schema.tables \
   WHERE table_name = 'marketplace_asset_authorizations';")
test "$marketplace_authorization_assertion" = 1

platform_audit_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT (SELECT count(*) FROM information_schema.tables \
             WHERE table_name = 'platform_audit_events'), \
          (SELECT count(*) FROM information_schema.tables \
             WHERE table_name = 'marketplace_subplatform_memberships');")
test "$platform_audit_assertion" = '1|1'

bash "$repository_root/tests/integration/generic-marketplace-smoke.sh"

echo 'MatchPlane end-to-end smoke test passed'
