#!/usr/bin/env bash
set -euo pipefail

# End-to-end contract for the seeded public Chinese vehicle storefront.
repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
source "$repository_root/tests/integration/http-json.sh"
http_json_root=${MATCHPLANE_SMOKE_TMPDIR:-$repository_root/.scratch/ci-smoke}
mkdir -p "$http_json_root"
HTTP_JSON_WORK_DIRECTORY=$(mktemp -d "$http_json_root/good-cars-http-json.XXXXXX")
export HTTP_JSON_WORK_DIRECTORY
trap 'rm -rf "$HTTP_JSON_WORK_DIRECTORY"' EXIT

web_base=${MATCHPLANE_WEB_BASE_URL:-http://127.0.0.1:${MATCHPLANE_WEB_HOST_PORT:-4173}}
gateway_base=${MATCHPLANE_BASE_URL:-http://127.0.0.1:${MATCHPLANE_GATEWAY_HOST_PORT:-8080}}
web_origin=${MATCHPLANE_WEB_ORIGIN:-${BETTER_AUTH_URL:-$web_base}}
tenant_id=00000000-0000-7000-8000-000000001000
domain_id=00000000-0000-7000-8000-000000001001
store_path=/good-cars
qin_offer_id=00000000-0000-7000-8000-000000001111
camry_offer_id=00000000-0000-7000-8000-000000001112
model3_offer_id=00000000-0000-7000-8000-000000001113
buyer_user_id=00000000-0000-7000-8000-000000001030
seller_user_id=00000000-0000-7000-8000-000000001031
intent_id=00000000-0000-7000-8000-000000001201
introduction_id=00000000-0000-7000-8000-000000001202
auth_secret=${MATCHPLANE_SMOKE_AUTH_SECRET:-${BETTER_AUTH_SECRET:-matchplane_dev_only_auth_secret_change_in_production}}

# Better Auth signs the database session token before placing it in the browser cookie.  Keep
# the fixture token deterministic, but build the same HMAC-SHA256 envelope as a real sign-in.
signed_auth_cookie() {
  local session_token=$1
  local signed_token
  signed_token=$(AUTH_COOKIE_SECRET="$auth_secret" AUTH_COOKIE_TOKEN="$session_token" node --input-type=module -e '
    import { createHmac } from "node:crypto";
    const token = process.env.AUTH_COOKIE_TOKEN ?? "";
    const secret = process.env.AUTH_COOKIE_SECRET ?? "";
    process.stdout.write(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
  ')
  printf 'better-auth.session_token=%s' "$signed_token"
}

buyer_cookie=$(signed_auth_cookie 'good-cars-buyer-session-token-000000000000000000000000000000')
seller_cookie=$(signed_auth_cookie 'good-cars-seller-session-token-000000000000000000000000000000')
platform_path_header="x-matchplane-platform-path: $store_path"

json_file() {
  printf '%s/%s' "$HTTP_JSON_WORK_DIRECTORY" "$1"
}

health_response=$(json_file health.json)
http_json "$health_response" "$web_base/api/health/web" --location
jq -e '.status == "ok" and .service == "matchplane-web"' "$health_response" >/dev/null

manifest_response=$(json_file manifest.json)
http_json "$manifest_response" "$web_base/api/platform/manifest?path=$store_path" --location
jq -e '.id == "good-cars" and .slug == "good-cars" and .marketplaceContract == "generic-v1" and (.assets | type == "object")' "$manifest_response" >/dev/null
jq -e '(.agent.mcpTools | index("catalog.search")) != null and (.agent.mcpTools | index("catalog.explain")) != null' "$manifest_response" >/dev/null
jq -e '((has("retrieval") | not) and (has("assetSchema") | not))' "$manifest_response" >/dev/null

browse_response=$(json_file browse.json)
http_json "$browse_response" "$web_base/api/mall/search?storePath=$store_path" --location
jq -e --arg qin "$qin_offer_id" --arg camry "$camry_offer_id" --arg model3 "$model3_offer_id" \
  '.stores == [{slug:"good-cars",path:"/good-cars",displayName:"好车线下店"}] and
   (.recommendations | length) == 3 and
   ([.recommendations[].offer_id] | sort) == ([$qin,$camry,$model3] | sort) and
   ([.recommendations[].terms.currency] | unique) == ["CNY"] and
   ([.recommendations[].attributes.description] | all(. != null and length > 0))' \
  "$browse_response" >/dev/null

for image_path in /good-cars/cars/qin.webp /good-cars/cars/camry.webp /good-cars/cars/model3.webp; do
  image_file=$(json_file "$(basename "$image_path")")
  image_metadata=$(curl --silent --show-error --fail --location \
    --output "$image_file" --write-out '%{http_code}\t%{content_type}' \
    "$web_base$image_path")
  test "$image_metadata" = $'200\timage/webp'
  test -s "$image_file"
done

search_response=$(json_file search.json)
printf '%s' '{"narrative":"预算20万元以内，家庭通勤，5座，深圳看车，优先插混或纯电","storePath":"/good-cars"}' |
  http_json "$search_response" "$web_base/api/mall/search" \
    --header 'content-type: application/json' --data-binary @-
jq -e --arg qin "$qin_offer_id" --arg model3 "$model3_offer_id" \
  '.stores[0].slug == "good-cars" and
   (.recommendations | length) == 3 and
   ([.recommendations[].offer_id] | index($qin)) != null and
   ([.recommendations[].offer_id] | index($model3)) != null and
   (.routing.source == "ai" or .routing.source == "policy_fallback")' \
  "$search_response" >/dev/null

# The Better Auth rows are seeded with verified email channels.  The web bridge must mint
# scoped capabilities from those sessions, while the client never supplies a contact field.
buyer_auth_response=$(json_file buyer-auth.json)
http_json "$buyer_auth_response" "$web_base/api/auth/get-session" \
  --header "cookie: $buyer_cookie"
jq -e --arg user "$buyer_user_id" '.user.id == $user and .user.email == "good-cars-buyer@example.invalid" and .user.emailVerified == true' "$buyer_auth_response" >/dev/null

seller_auth_response=$(json_file seller-auth.json)
http_json "$seller_auth_response" "$web_base/api/auth/get-session" \
  --header "cookie: $seller_cookie"
jq -e --arg user "$seller_user_id" '.user.id == $user and .user.email == "good-cars-seller@example.invalid" and .user.emailVerified == true' "$seller_auth_response" >/dev/null

buyer_session_response=$(json_file buyer-session.json)
printf '%s' "{\"tenantId\":\"$tenant_id\",\"domainId\":\"$domain_id\",\"subplatform\":\"good-cars\",\"platformPath\":\"$store_path\",\"role\":\"buyer\"}" |
http_json "$buyer_session_response" "$web_base/api/marketplace/session" \
    --header "cookie: $buyer_cookie" --header "origin: $web_origin" \
    --header 'content-type: application/json' --data-binary @-
buyer_party_id=$(jq -er '.party_id' "$buyer_session_response")
buyer_token=$(jq -er '.access_token' "$buyer_session_response")

seller_session_response=$(json_file seller-session.json)
printf '%s' "{\"tenantId\":\"$tenant_id\",\"domainId\":\"$domain_id\",\"subplatform\":\"good-cars\",\"platformPath\":\"$store_path\",\"role\":\"seller\"}" |
http_json "$seller_session_response" "$web_base/api/marketplace/session" \
    --header "cookie: $seller_cookie" --header "origin: $web_origin" \
    --header 'content-type: application/json' --data-binary @-
seller_party_id=$(jq -er '.party_id' "$seller_session_response")
seller_token=$(jq -er '.access_token' "$seller_session_response")
test "$seller_party_id" = 00000000-0000-7000-8000-000000001020

likes_before=$(json_file likes-before.json)
http_json "$likes_before" "$web_base/api/mall/likes?offerIds=$qin_offer_id" \
  --header "cookie: $buyer_cookie"
jq -e --arg offer "$qin_offer_id" '.likes == [{offerId:$offer,viewerLikeCount:0,likeTotal:"0"}]' "$likes_before" >/dev/null

like_response=$(json_file like.json)
printf '%s' '{"count":1,"expectedCount":0}' |
  http_json "$like_response" "$web_base/api/mall/offers/$qin_offer_id/likes" \
    --header "cookie: $buyer_cookie" --header "origin: $web_origin" \
    --header 'content-type: application/json' --data-binary @- -X PUT
jq -e --arg offer "$qin_offer_id" '.offerId == $offer and .viewerLikeCount == 1 and .likeTotal == "1"' "$like_response" >/dev/null

intent_response=$(json_file intent.json)
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg buyer "$buyer_party_id" \
  '{intent_id:"00000000-0000-7000-8000-000000001201",tenant_id:$tenant,domain_id:$domain,participant_id:$buyer,side:"demand",narrative:"预算20万元以内，家庭通勤，优先插混或纯电",attributes:{fuel_type:"插混或纯电",seats:5},terms:{budget:{minimum:0,maximum:200000,currency:"CNY"}},supply_discovery_enabled:true,idempotency_key:"good-cars-intent-v1"}' |
  http_json "$intent_response" "$gateway_base/v1/marketplace/intents" \
    --header 'content-type: application/json' --header "authorization: Bearer $buyer_token" \
    --header "$platform_path_header" --data-binary @-
jq -e '.side == "demand" and .status == "active"' "$intent_response" >/dev/null

expires_at=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ')
introduction_response=$(json_file introduction.json)
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg intent "$intent_id" \
  --arg offer "$qin_offer_id" --arg buyer "$buyer_party_id" --arg expires "$expires_at" \
  '{introduction_id:"00000000-0000-7000-8000-000000001202",tenant_id:$tenant,domain_id:$domain,intent_id:$intent,offer_id:$offer,participant_id:$buyer,score:1,reasons:["预算在20万元以内","家庭通勤","公开车况"],idempotency_key:"good-cars-introduction-v1",expires_at:$expires}' |
  http_json "$introduction_response" "$gateway_base/v1/marketplace/introductions" \
    --header 'content-type: application/json' --header "authorization: Bearer $buyer_token" \
    --header "$platform_path_header" --data-binary @-
jq -e --arg intro "$introduction_id" '.introduction_id == $intro and .status == "proposed"' "$introduction_response" >/dev/null

contact_before_consent=$(json_file contact-before-consent.json)
http_json_expect_status 409 "$contact_before_consent" \
  "$gateway_base/v1/marketplace/introductions/$introduction_id/contact" \
  --header 'content-type: application/json' --header "authorization: Bearer $buyer_token" \
  --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$buyer_party_id\",\"idempotency_key\":\"good-cars-contact-before-consent\"}" \
  -X POST
jq -e 'type == "object"' "$contact_before_consent" >/dev/null

contact_request=$(json_file contact-request.json)
http_json "$contact_request" "$gateway_base/v1/marketplace/introductions/$introduction_id/contact/request" \
  --header 'content-type: application/json' --header "authorization: Bearer $buyer_token" \
  --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$buyer_party_id\",\"idempotency_key\":\"good-cars-contact-request\"}"
jq -e '.status == "contact_requested"' "$contact_request" >/dev/null

contact_consent=$(json_file contact-consent.json)
http_json "$contact_consent" "$gateway_base/v1/marketplace/introductions/$introduction_id/contact/consent" \
  --header 'content-type: application/json' --header "authorization: Bearer $seller_token" \
  --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$seller_party_id\",\"idempotency_key\":\"good-cars-contact-consent\"}"
jq -e '.supply_contact_consent_at != null' "$contact_consent" >/dev/null

contact_response=$(json_file contact.json)
http_json "$contact_response" "$gateway_base/v1/marketplace/introductions/$introduction_id/contact" \
  --header 'content-type: application/json' --header "authorization: Bearer $buyer_token" \
  --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$buyer_party_id\",\"idempotency_key\":\"good-cars-contact-release\"}" \
  -X POST
jq -e '.counterpart.party_id == "00000000-0000-7000-8000-000000001020" and .counterpart.contact.email == "good-cars-seller@example.invalid" and .introduction.status == "contact_released"' "$contact_response" >/dev/null

seller_contact_response=$(json_file seller-contact.json)
http_json "$seller_contact_response" "$gateway_base/v1/marketplace/introductions/$introduction_id/contact" \
  --header 'content-type: application/json' --header "authorization: Bearer $seller_token" \
  --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$seller_party_id\",\"idempotency_key\":\"good-cars-contact-release-seller\"}" \
  -X POST
jq -e '.counterpart.party_id == $buyer and .counterpart.contact.email == "good-cars-buyer@example.invalid"' --arg buyer "$buyer_party_id" "$seller_contact_response" >/dev/null

if [[ ${MATCHPLANE_REQUIRE_AI_SMOKE:-false} == true ]]; then
  assistant_response=$(json_file assistant.json)
  jq -nc '{messages:[{role:"user",content:"我想买一辆预算20万元以内、用于家庭通勤的车，优先插混或纯电"}],storePath:"/good-cars"}' |
    http_json "$assistant_response" "$web_base/api/mall/assistant" \
      --header 'content-type: application/json' --data-binary @-
  jq -e '(.recommendations | length) >= 1 and (.uiActions | map(select(.type == "products")) | length) >= 1 and (.searchTrace.toolCalls | index("search_public_products")) != null' "$assistant_response" >/dev/null
fi

printf 'good-cars storefront smoke passed\n'
