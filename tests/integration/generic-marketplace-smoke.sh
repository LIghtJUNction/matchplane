#!/usr/bin/env bash
set -euo pipefail

# Primary marketplace smoke test for the neutral kernel contract. It intentionally avoids
# vertical names, fields, and the legacy compatibility adapter.
repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Keep every captured response under the repository scratch tree; never use /tmp.
source "$repository_root/tests/integration/http-json.sh"
http_json_root=${MATCHPLANE_SMOKE_TMPDIR:-$repository_root/.scratch/ci-smoke}
mkdir -p "$http_json_root"
HTTP_JSON_WORK_DIRECTORY=$(mktemp -d "$http_json_root/generic-http-json.XXXXXX")
export HTTP_JSON_WORK_DIRECTORY
trap 'rm -rf "$HTTP_JSON_WORK_DIRECTORY"' EXIT
env_file="$repository_root/.env.example"
if [[ -f "$repository_root/.env" ]]; then env_file="$repository_root/.env"; fi
compose=(docker compose --env-file "$env_file" -f "$repository_root/deploy/compose/compose.yaml")
base_url=${MATCHPLANE_BASE_URL:-http://127.0.0.1:8080}
payment_url=${MATCHPLANE_PAYMENT_BASE_URL:-http://127.0.0.1:8081}
tenant_id=00000000-0000-7000-8000-000000000100
domain_id=00000000-0000-7000-8000-000000000101
intent_id=00000000-0000-7000-8000-000000000901
offer_id=00000000-0000-7000-8000-000000000902
introduction_id=00000000-0000-7000-8000-000000000903
admin_authorization='authorization: Bearer matchplane-development-gateway-admin'
payment_admin_authorization='authorization: Bearer matchplane-development-admin'
platform_path=/ci-platform
platform_path_header="x-matchplane-platform-path: $platform_path"

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

wait_for 'payment readiness' "$payment_url/health/ready" '.status == "ready"'

supply_response="$HTTP_JSON_WORK_DIRECTORY/supply.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" \
  '{tenant_id:$tenant,domain_id:$domain,platform_path:"/ci-platform",external_key:"ci-supply",display_name:"Integration supply",marketplace_sides:["supply"],contact:{email:"supply@example.invalid",channel:"ci"}}' \
  | http_json "$supply_response" "$base_url/v1/marketplace/participants" \
    --header 'content-type: application/json' --data-binary @-
supply_id=$(jq -er '.party_id' "$supply_response")
supply_token=$(jq -er '.access_token' "$supply_response")

demand_response="$HTTP_JSON_WORK_DIRECTORY/demand.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" \
  '{tenant_id:$tenant,domain_id:$domain,platform_path:"/ci-platform",external_key:"ci-demand",display_name:"Integration demand",marketplace_sides:["demand"],contact:{email:"demand@example.invalid",channel:"ci"}}' \
  | http_json "$demand_response" "$base_url/v1/marketplace/participants" \
    --header 'content-type: application/json' --data-binary @-
demand_id=$(jq -er '.party_id' "$demand_response")
demand_token=$(jq -er '.access_token' "$demand_response")

offer_response="$HTTP_JSON_WORK_DIRECTORY/offer.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg supply "$supply_id" \
  '{offer_id:"00000000-0000-7000-8000-000000000902",tenant_id:$tenant,domain_id:$domain,supply_party_id:$supply,external_key:"ci-offer",display_name:"Integration offer",attributes:{category:"integration-item",edition:"v1"},terms:{amount:"2500000",currency:"USD",scale:2}}' \
  | http_json "$offer_response" "$base_url/v1/marketplace/offers" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $supply_token" --header "$platform_path_header" --data-binary @-
test "$(jq -r '.status' "$offer_response")" = draft
offer_version=$(jq -er 'if (.version | type) == "number" and (.version | floor) == .version and .version >= 0 then .version else error("offer version must be a non-negative integer") end' "$offer_response")

activate_request=$(jq -nc --arg tenant "$tenant_id" --argjson expected_version "$offer_version" \
  '{tenant_id:$tenant,expected_version:$expected_version}')
activate_response="$HTTP_JSON_WORK_DIRECTORY/activate.json"
printf '%s' "$activate_request" \
  | http_json "$activate_response" "$base_url/v1/admin/marketplace/offers/$offer_id/activate" \
    --header "$admin_authorization" --header 'content-type: application/json' --data-binary @-
jq -e '.status == "active" and .offer_id == "00000000-0000-7000-8000-000000000902"' "$activate_response" >/dev/null

intent_response="$HTTP_JSON_WORK_DIRECTORY/intent.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg demand "$demand_id" \
  '{intent_id:"00000000-0000-7000-8000-000000000901",tenant_id:$tenant,domain_id:$domain,participant_id:$demand,side:"demand",narrative:"Integration demand",attributes:{category:"integration-item",edition:"v1"},terms:{budget:{min:"2000000",max:"3000000",currency:"USD"}},supply_discovery_enabled:true,idempotency_key:"ci-generic-intent-v1"}' \
  | http_json "$intent_response" "$base_url/v1/marketplace/intents" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $demand_token" --header "$platform_path_header" --data-binary @-
test "$(jq -r '.side' "$intent_response")" = demand

matches_response="$HTTP_JSON_WORK_DIRECTORY/matches.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg demand "$demand_id" \
  '{tenant_id:$tenant,domain_id:$domain,participant_id:$demand,limit:10}' \
  | http_json "$matches_response" "$base_url/v1/marketplace/intents/$intent_id/matches" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $demand_token" --header "$platform_path_header" --data-binary @-
jq -e --arg offer "$offer_id" \
  '.intent_id == "00000000-0000-7000-8000-000000000901" and
   (.candidates | length) == 1 and
   .candidates[0].offer_id == $offer and
   (.candidates[0].score >= 0.8 and .candidates[0].score <= 1) and
   ((.candidates[0].reasons | index("shared attribute: category")) != null) and
   ((.candidates[0].reasons | index("shared attribute: edition")) != null)' \
  "$matches_response" >/dev/null

demand_matches_response="$HTTP_JSON_WORK_DIRECTORY/demand-matches.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg supply "$supply_id" --arg offer "$offer_id" \
  '{tenant_id:$tenant,domain_id:$domain,participant_id:$supply,offer_id:$offer,limit:10}' \
  | http_json "$demand_matches_response" "$base_url/v1/marketplace/offers/$offer_id/demand-matches" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $supply_token" --header "$platform_path_header" --data-binary @-
jq -e --arg intent "$intent_id" \
  '.offer_id == "00000000-0000-7000-8000-000000000902" and
   (.candidates | length) == 1 and
   .candidates[0].intent_id == $intent and
   (.candidates[0].score >= 0.8 and .candidates[0].score <= 1) and
   (.candidates[0] | has("participant_id") | not)' \
  "$demand_matches_response" >/dev/null

discovery_off_response="$HTTP_JSON_WORK_DIRECTORY/discovery-off.json"
http_json "$discovery_off_response" "$base_url/v1/marketplace/intents/$intent_id/discovery" \
  --header 'content-type: application/json' \
  --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$demand_id\",\"enabled\":false}" \
  -X PATCH
jq -e '.supply_discovery_enabled == false' "$discovery_off_response" >/dev/null
revoked_matches_response="$HTTP_JSON_WORK_DIRECTORY/revoked-matches.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg supply "$supply_id" --arg offer "$offer_id" \
  '{tenant_id:$tenant,domain_id:$domain,participant_id:$supply,offer_id:$offer,limit:10}' \
  | http_json "$revoked_matches_response" "$base_url/v1/marketplace/offers/$offer_id/demand-matches" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $supply_token" --header "$platform_path_header" --data-binary @-
jq -e '.candidates | length == 0' "$revoked_matches_response" >/dev/null
discovery_on_response="$HTTP_JSON_WORK_DIRECTORY/discovery-on.json"
http_json "$discovery_on_response" "$base_url/v1/marketplace/intents/$intent_id/discovery" \
  --header 'content-type: application/json' \
  --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$demand_id\",\"enabled\":true}" \
  -X PATCH
jq -e '.supply_discovery_enabled == true' "$discovery_on_response" >/dev/null

expires_at=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ')
introduction_response="$HTTP_JSON_WORK_DIRECTORY/introduction.json"
jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg intent "$intent_id" \
  --arg offer "$offer_id" --arg demand "$demand_id" --arg expires "$expires_at" \
  '{introduction_id:"00000000-0000-7000-8000-000000000903",tenant_id:$tenant,domain_id:$domain,intent_id:$intent,offer_id:$offer,participant_id:$demand,score:1,reasons:["shared attribute: category","shared attribute: edition"],idempotency_key:"ci-generic-introduction-v1",expires_at:$expires}' \
  | http_json "$introduction_response" "$base_url/v1/marketplace/introductions" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $demand_token" --header "$platform_path_header" --data-binary @-
test "$(jq -r '.introduction_id' "$introduction_response")" = "$introduction_id"

contact_before_consent_response="$HTTP_JSON_WORK_DIRECTORY/contact-before-consent.json"
http_json_expect_status 409 "$contact_before_consent_response" \
  "$base_url/v1/marketplace/introductions/$introduction_id/contact" \
  --header 'content-type: application/json' --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$demand_id\",\"idempotency_key\":\"ci-contact-release-before-consent-$introduction_id\"}" \
  -X POST
jq -e 'type == "object"' "$contact_before_consent_response" >/dev/null

contact_request_response="$HTTP_JSON_WORK_DIRECTORY/contact-request.json"
http_json "$contact_request_response" "$base_url/v1/marketplace/introductions/$introduction_id/contact/request" \
  --header 'content-type: application/json' \
  --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$demand_id\",\"idempotency_key\":\"ci-contact-request-$introduction_id\"}"
jq -e '.status == "contact_requested"' "$contact_request_response" >/dev/null

contact_consent_response="$HTTP_JSON_WORK_DIRECTORY/contact-consent.json"
http_json "$contact_consent_response" "$base_url/v1/marketplace/introductions/$introduction_id/contact/consent" \
  --header 'content-type: application/json' \
  --header "authorization: Bearer $supply_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$supply_id\",\"idempotency_key\":\"ci-contact-consent-$introduction_id\"}"
jq -e '.supply_contact_consent_at != null' "$contact_consent_response" >/dev/null

contact_response="$HTTP_JSON_WORK_DIRECTORY/contact.json"
http_json "$contact_response" "$base_url/v1/marketplace/introductions/$introduction_id/contact" \
  --header 'content-type: application/json' --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$demand_id\",\"idempotency_key\":\"ci-contact-release-demand-$introduction_id\"}" \
  -X POST
test "$(jq -r '.counterpart.party_id' "$contact_response")" = "$supply_id"
test "$(jq -r '.counterpart.contact.email' "$contact_response")" = supply@example.invalid

supply_contact_response="$HTTP_JSON_WORK_DIRECTORY/supply-contact.json"
http_json "$supply_contact_response" "$base_url/v1/marketplace/introductions/$introduction_id/contact" \
  --header 'content-type: application/json' --header "authorization: Bearer $supply_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$supply_id\",\"idempotency_key\":\"ci-contact-release-supply-$introduction_id\"}" \
  -X POST
test "$(jq -r '.counterpart.party_id' "$supply_contact_response")" = "$demand_id"
test "$(jq -r '.counterpart.contact.email' "$supply_contact_response")" = demand@example.invalid

payment_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" --arg supply "$supply_id" \
  '{tenant_id:$tenant,source_type:"marketplace_introduction",source_ref:$source,payer_party_id:$supply,merchant_order_id:("ci-commission-"+$source),idempotency_key:("ci-authorize-"+$source),transaction_channel:"online_platform",purpose:"platform_commission",amount:{amount:"25000",currency:"USD",scale:2},commission_amount:"25000",method:"card",notify_url:"https://example.invalid/payment-notify",return_url:"https://example.invalid/payment-return",description:"CI platform commission"}')
unauthenticated_payment_response="$HTTP_JSON_WORK_DIRECTORY/payment-unauthenticated.json"
http_json_expect_status 401 "$unauthenticated_payment_response" "$payment_url/v1/payments/authorize" \
  --header 'content-type: application/json' --data "$payment_request"
wrong_party_payment_response="$HTTP_JSON_WORK_DIRECTORY/payment-wrong-party.json"
http_json_expect_status 401 "$wrong_party_payment_response" "$payment_url/v1/payments/authorize" \
  --header 'content-type: application/json' --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "$payment_request"
jq -e 'type == "object"' "$unauthenticated_payment_response" >/dev/null
jq -e 'type == "object"' "$wrong_party_payment_response" >/dev/null

payment_response="$HTTP_JSON_WORK_DIRECTORY/payment.json"
printf '%s' "$payment_request" \
  | http_json "$payment_response" "$payment_url/v1/payments/authorize" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $supply_token" --header "$platform_path_header" --data-binary @-
payment_id=$(jq -er '.payment_id' "$payment_response")
test "$(jq -r '.status' "$payment_response")" = authorized

reconciliation_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-reconcile-"+$source)}')
reconciliation_response="$HTTP_JSON_WORK_DIRECTORY/reconciliation.json"
printf '%s' "$reconciliation_request" \
  | http_json "$reconciliation_response" "$payment_url/v1/payments/$payment_id/reconcile" \
    --header 'content-type: application/json' \
    --header "$payment_admin_authorization" --data-binary @-
jq -e '.status == "authorized" and .duplicate == false' "$reconciliation_response" >/dev/null

capture_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-capture-"+$source),amount:"24000"}')
capture_response="$HTTP_JSON_WORK_DIRECTORY/capture.json"
printf '%s' "$capture_request" \
  | http_json "$capture_response" "$payment_url/v1/payments/$payment_id/capture" \
    --header 'content-type: application/json' \
    --header "$payment_admin_authorization" --data-binary @-
jq -e '.status == "captured" and .commission_amount == "24000"' "$capture_response" >/dev/null

invoice_request=$(jq -nc --arg tenant "$tenant_id" --arg payment "$payment_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,payment_id:$payment,source_type:"marketplace_introduction",source_ref:$source,kind:"platform_commission",idempotency_key:("ci-invoice-"+$source),amount:{amount:"24000",currency:"USD",scale:2},description:"CI platform commission",billing_details:{title:"Integration recipient",tax_identifier:"CI-TAX-001",email:"recipient@example.invalid",registered_address_phone:null,bank_account:null},requested_by:"ci-operator"}')
invoice_response="$HTTP_JSON_WORK_DIRECTORY/invoice.json"
printf '%s' "$invoice_request" \
  | http_json "$invoice_response" "$payment_url/v1/invoices" \
    --header 'content-type: application/json' \
    --header "$payment_admin_authorization" --data-binary @-
invoice_id=$(jq -er '.invoice_id' "$invoice_response")
test "$(jq -r '.status' "$invoice_response")" = requested

issue_response="$HTTP_JSON_WORK_DIRECTORY/invoice-issue.json"
http_json "$issue_response" "$payment_url/v1/invoices/$invoice_id/issue" \
  --header 'content-type: application/json' \
  --header "$payment_admin_authorization" --data '{"actor":"ci-operator"}'
jq -e '.status == "issued" and .provider_mode == "test"' "$issue_response" >/dev/null
download_response="$HTTP_JSON_WORK_DIRECTORY/invoice-download.json"
http_json "$download_response" "$payment_url/v1/invoices/$invoice_id/download" \
  --header "$payment_admin_authorization"
jq -e '.test_mode == true and .kind == "platform_commission" and .amount.amount == "24000"' "$download_response" >/dev/null

refund_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-refund-"+$source),amount:"12000",reason:"CI partial commission refund"}')
refund_response="$HTTP_JSON_WORK_DIRECTORY/refund.json"
printf '%s' "$refund_request" \
  | http_json "$refund_response" "$payment_url/v1/payments/$payment_id/refunds" \
    --header 'content-type: application/json' \
    --header "$payment_admin_authorization" --data-binary @-
test "$(jq -r '.status' "$refund_response")" = succeeded
test "$(jq -r '.commission_reversal_amount' "$refund_response")" = 12000

corrections_response="$HTTP_JSON_WORK_DIRECTORY/corrections.json"
http_json "$corrections_response" "$payment_url/v1/invoices/$invoice_id/corrections" \
  --header "$payment_admin_authorization"
correction_id=$(jq -er '.[0].invoice_id' "$corrections_response")
jq -e 'length == 1 and .[0].status == "red_letter_pending" and .[0].amount == "12000"' \
  "$corrections_response" >/dev/null
red_letter_response="$HTTP_JSON_WORK_DIRECTORY/red-letter.json"
http_json "$red_letter_response" "$payment_url/v1/invoices/$correction_id/red-letter" \
  --header 'content-type: application/json' \
  --header "$payment_admin_authorization" --data '{"actor":"ci-operator"}'
jq -e '.status == "red_lettered"' "$red_letter_response" >/dev/null
credit_note_response="$HTTP_JSON_WORK_DIRECTORY/credit-note.json"
http_json "$credit_note_response" "$payment_url/v1/invoices/$correction_id/download?artifact=credit_note" \
  --header "$payment_admin_authorization"
jq -e '.test_mode == true and .kind == "platform_commission" and .amount.amount == "12000"' "$credit_note_response" >/dev/null

privacy_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT (SELECT bool_and(position(convert_to('supply@example.invalid', 'UTF8') in contact_ciphertext)=0) FROM marketplace_parties), (SELECT count(*) FROM marketplace_introduction_contact_events WHERE decision='denied'), (SELECT count(*) FROM marketplace_introduction_contact_events WHERE decision='allowed');")
test "$privacy_assertion" = 't|1|4'

echo 'MatchPlane generic marketplace smoke test passed'
