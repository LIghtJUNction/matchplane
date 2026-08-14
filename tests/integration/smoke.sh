#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose=(docker compose --env-file "$repository_root/.env.example" -f "$repository_root/deploy/compose/compose.yaml")
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
work_directory=$(mktemp -d)
trap 'rm -rf "$work_directory"' EXIT

wait_for() {
  local description=$1
  local command=$2
  for _ in $(seq 1 90); do
    if bash -o pipefail -c "$command" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for $description" >&2
  return 1
}

wait_for 'gateway readiness' "curl --fail --silent '$base_url/health/ready' | jq -e '.status == \"ready\"'"

unauthenticated_core=$(curl --silent --output /dev/null --write-out '%{http_code}' "$base_url/v1/demo")
test "$unauthenticated_core" = 401

curl --fail-with-body --silent --request POST "$base_url/v1/embeddings" \
  --header "$core_authorization" --header 'content-type: application/json' \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"asset_id\":\"$asset_id\",\"embedding_model_id\":\"$model_id\",\"values\":[0.1,0.2,0.3]}"
curl --fail-with-body --silent --request POST "$base_url/v1/candidates/search" \
  --header "$core_authorization" --header 'content-type: application/json' \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"embedding_model_id\":\"$model_id\",\"values\":[0.1,0.2,0.3],\"limit\":5}" \
  | jq -e --arg asset "$asset_id" 'length == 1 and .[0].asset_id == $asset' >/dev/null

seller_request="$work_directory/seller.json"
buyer_one_request="$work_directory/buyer-one.json"
buyer_two_request="$work_directory/buyer-two.json"
printf '%s\n' "{\"order_id\":\"00000000-0000-7000-8000-000000008001\",\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"market_id\":\"$market_id\",\"side\":\"sell\",\"price\":\"100\",\"quantity\":\"5\",\"idempotency_key\":\"smoke-seller-v1\",\"reservation_account_id\":\"$seller_base\",\"settlement_account_id\":\"$seller_quote\",\"submitted_at\":\"2026-08-14T01:00:00Z\"}" >"$seller_request"
printf '%s\n' "{\"order_id\":\"00000000-0000-7000-8000-000000008002\",\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"market_id\":\"$market_id\",\"side\":\"buy\",\"price\":\"110\",\"quantity\":\"3\",\"idempotency_key\":\"smoke-buyer-one-v1\",\"reservation_account_id\":\"$buyer_quote\",\"settlement_account_id\":\"$buyer_base\",\"submitted_at\":\"2026-08-14T01:00:01Z\"}" >"$buyer_one_request"
printf '%s\n' "{\"order_id\":\"00000000-0000-7000-8000-000000008003\",\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"market_id\":\"$market_id\",\"side\":\"buy\",\"price\":\"110\",\"quantity\":\"2\",\"idempotency_key\":\"smoke-buyer-two-v1\",\"reservation_account_id\":\"$buyer_quote\",\"settlement_account_id\":\"$buyer_base\",\"submitted_at\":\"2026-08-14T01:00:02Z\"}" >"$buyer_two_request"

curl --fail-with-body --silent --request POST "$base_url/v1/orders" \
  --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$seller_request" | jq -e '.duplicate == false' >/dev/null
wait_for 'seller order admission' "curl --fail --silent --header '$core_authorization' '$base_url/v1/orders/00000000-0000-7000-8000-000000008001' | jq -e '.status == \"open\"'"

curl --fail-with-body --silent --request POST "$base_url/v1/orders" \
  --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$buyer_one_request" | jq -e '.duplicate == false' >/dev/null
curl --fail-with-body --silent --request POST "$base_url/v1/orders" \
  --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$buyer_one_request" | jq -e '.duplicate == true' >/dev/null
wait_for 'first deterministic trade' "curl --fail --silent --header '$core_authorization' '$base_url/v1/markets/$market_id/trades' | jq -e 'length == 1 and .[0].price == \"100\" and .[0].quantity == \"3\"'"
wait_for 'first projected book' "curl --fail --silent --header '$core_authorization' '$base_url/v1/markets/$market_id/book' | jq -e '.sequence == 2 and (.asks | length) == 1 and .asks[0].price == \"100\" and .asks[0].quantity == \"2\"'"

conflict_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST "$base_url/v1/orders" \
  --header "$core_authorization" --header 'content-type: application/json' \
  --data "$(sed 's/\"quantity\":\"3\"/\"quantity\":\"4\"/' "$buyer_one_request")")
test "$conflict_status" = 409

"${compose[@]}" restart matcher >/dev/null
curl --fail-with-body --silent --request POST "$base_url/v1/orders" \
  --header "$core_authorization" --header 'content-type: application/json' --data-binary "@$buyer_two_request" | jq -e '.duplicate == false' >/dev/null
wait_for 'post-restart snapshot recovery and trade' "curl --fail --silent --header '$core_authorization' '$base_url/v1/markets/$market_id/trades' | jq -e 'length == 2'"
wait_for 'empty projected book after second fill' "curl --fail --silent --header '$core_authorization' '$base_url/v1/markets/$market_id/book' | jq -e '.sequence == 3 and (.bids | length) == 0 and (.asks | length) == 0'"

database_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane --tuples-only --no-align --command \
  "SELECT (SELECT count(*) FROM orders), (SELECT count(*) FROM trades), (SELECT count(*) FROM ledger_entries), (SELECT count(*) FROM consumer_inbox WHERE status='applied'), (SELECT count(*) FROM asset_embeddings), (SELECT available_amount::text FROM accounts WHERE id='00000000-0000-7000-8000-000000000505');")
test "$database_assertion" = '3|2|10|3|1|5'

extension_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane --tuples-only --no-align --command \
  "SELECT extname || '=' || extversion FROM pg_extension WHERE extname IN ('timescaledb','vector') ORDER BY extname;")
printf '%s\n' "$extension_assertion" | grep -Fx 'timescaledb=2.29.1' >/dev/null
printf '%s\n' "$extension_assertion" | grep -Fx 'vector=0.8.6' >/dev/null

bash "$repository_root/tests/integration/marketplace-smoke.sh"

echo 'MatchPlane end-to-end smoke test passed'
