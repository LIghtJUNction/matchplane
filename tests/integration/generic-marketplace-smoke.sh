#!/usr/bin/env bash
set -euo pipefail

# Primary marketplace smoke test for the neutral kernel contract. It intentionally avoids
# vertical names, fields, and the legacy compatibility adapter.
repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose=(docker compose --env-file "$repository_root/.env.example" -f "$repository_root/deploy/compose/compose.yaml")
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

wait_for 'payment readiness' "curl --fail --silent '$payment_url/health/ready' | jq -e '.status == \"ready\"'"

supply=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" \
  '{tenant_id:$tenant,domain_id:$domain,platform_path:"/ci-platform",external_key:"ci-supply",display_name:"Integration supply",marketplace_sides:["supply"],contact:{email:"supply@example.invalid",channel:"ci"}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' --data-binary @- \
      "$base_url/v1/marketplace/participants")
supply_id=$(jq -er '.party_id' <<<"$supply")
supply_token=$(jq -er '.access_token' <<<"$supply")

demand=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" \
  '{tenant_id:$tenant,domain_id:$domain,platform_path:"/ci-platform",external_key:"ci-demand",display_name:"Integration demand",marketplace_sides:["demand"],contact:{email:"demand@example.invalid",channel:"ci"}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' --data-binary @- \
      "$base_url/v1/marketplace/participants")
demand_id=$(jq -er '.party_id' <<<"$demand")
demand_token=$(jq -er '.access_token' <<<"$demand")

offer=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg supply "$supply_id" \
  '{offer_id:"00000000-0000-7000-8000-000000000902",tenant_id:$tenant,domain_id:$domain,supply_party_id:$supply,external_key:"ci-offer",display_name:"Integration offer",attributes:{category:"integration-item",edition:"v1"},terms:{amount:"2500000",currency:"USD",scale:2}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $supply_token" --header "$platform_path_header" --data-binary @- \
      "$base_url/v1/marketplace/offers")
test "$(jq -r '.status' <<<"$offer")" = draft

curl --fail-with-body --silent --header "$admin_authorization" --header 'content-type: application/json' \
  --data "{\"tenant_id\":\"$tenant_id\"}" \
  "$base_url/v1/admin/marketplace/offers/$offer_id/activate" \
  | jq -e '.status == "active" and .offer_id == "00000000-0000-7000-8000-000000000902"' >/dev/null

intent=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg demand "$demand_id" \
  '{intent_id:"00000000-0000-7000-8000-000000000901",tenant_id:$tenant,domain_id:$domain,participant_id:$demand,side:"demand",narrative:"Integration demand",attributes:{category:"integration-item",edition:"v1"},terms:{budget:{min:"2000000",max:"3000000",currency:"USD"}},idempotency_key:"ci-generic-intent-v1"}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $demand_token" --header "$platform_path_header" --data-binary @- \
      "$base_url/v1/marketplace/intents")
test "$(jq -r '.side' <<<"$intent")" = demand

matches=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg demand "$demand_id" \
  '{tenant_id:$tenant,domain_id:$domain,participant_id:$demand,limit:10}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $demand_token" --header "$platform_path_header" --data-binary @- \
      "$base_url/v1/marketplace/intents/$intent_id/matches")
jq -e --arg offer "$offer_id" \
  '.intent_id == "00000000-0000-7000-8000-000000000901" and (.candidates | length) == 1 and .candidates[0].offer_id == $offer and .candidates[0].score == 1' \
  <<<"$matches" >/dev/null

expires_at=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ')
introduction=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg intent "$intent_id" \
  --arg offer "$offer_id" --arg demand "$demand_id" --arg expires "$expires_at" \
  '{introduction_id:"00000000-0000-7000-8000-000000000903",tenant_id:$tenant,domain_id:$domain,intent_id:$intent,offer_id:$offer,participant_id:$demand,score:1,reasons:["shared attribute: category","shared attribute: edition"],idempotency_key:"ci-generic-introduction-v1",expires_at:$expires}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $demand_token" --header "$platform_path_header" --data-binary @- \
      "$base_url/v1/marketplace/introductions")
test "$(jq -r '.introduction_id' <<<"$introduction")" = "$introduction_id"

contact_before_consent=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  "$base_url/v1/marketplace/introductions/$introduction_id/contact?tenant_id=$tenant_id&domain_id=$domain_id&participant_id=$demand_id")
test "$contact_before_consent" = 409

curl --fail-with-body --silent --header 'content-type: application/json' \
  --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$demand_id\"}" \
  "$base_url/v1/marketplace/introductions/$introduction_id/contact/request" \
  | jq -e '.status == "contact_requested"' >/dev/null

curl --fail-with-body --silent --header 'content-type: application/json' \
  --header "authorization: Bearer $supply_token" --header "$platform_path_header" \
  --data "{\"tenant_id\":\"$tenant_id\",\"domain_id\":\"$domain_id\",\"participant_id\":\"$supply_id\"}" \
  "$base_url/v1/marketplace/introductions/$introduction_id/contact/consent" \
  | jq -e '.supply_contact_consent_at != null' >/dev/null

contact=$(curl --fail-with-body --silent --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  "$base_url/v1/marketplace/introductions/$introduction_id/contact?tenant_id=$tenant_id&domain_id=$domain_id&participant_id=$demand_id")
test "$(jq -r '.counterpart.party_id' <<<"$contact")" = "$supply_id"
test "$(jq -r '.counterpart.contact.email' <<<"$contact")" = supply@example.invalid

supply_contact=$(curl --fail-with-body --silent --header "authorization: Bearer $supply_token" --header "$platform_path_header" \
  "$base_url/v1/marketplace/introductions/$introduction_id/contact?tenant_id=$tenant_id&domain_id=$domain_id&participant_id=$supply_id")
test "$(jq -r '.counterpart.party_id' <<<"$supply_contact")" = "$demand_id"
test "$(jq -r '.counterpart.contact.email' <<<"$supply_contact")" = demand@example.invalid

payment_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" --arg supply "$supply_id" \
  '{tenant_id:$tenant,source_type:"marketplace_introduction",source_ref:$source,payer_party_id:$supply,merchant_order_id:("ci-commission-"+$source),idempotency_key:("ci-authorize-"+$source),transaction_channel:"online_platform",purpose:"platform_commission",amount:{amount:"25000",currency:"USD",scale:2},commission_amount:"25000",method:"card",notify_url:"https://example.invalid/payment-notify",return_url:"https://example.invalid/payment-return",description:"CI platform commission"}')
unauthenticated_payment=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --data "$payment_request" \
  "$payment_url/v1/payments/authorize")
wrong_party_payment=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --header "authorization: Bearer $demand_token" --header "$platform_path_header" \
  --data "$payment_request" "$payment_url/v1/payments/authorize")
test "$unauthenticated_payment" = 401
test "$wrong_party_payment" = 401

payment=$(printf '%s' "$payment_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $supply_token" --header "$platform_path_header" --data-binary @- \
      "$payment_url/v1/payments/authorize")
payment_id=$(jq -er '.payment_id' <<<"$payment")
test "$(jq -r '.status' <<<"$payment")" = authorized

reconciliation_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-reconcile-"+$source)}')
printf '%s' "$reconciliation_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$payment_admin_authorization" --data-binary @- \
      "$payment_url/v1/payments/$payment_id/reconcile" \
  | jq -e '.status == "authorized" and .duplicate == false' >/dev/null

capture_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-capture-"+$source),amount:"24000"}')
printf '%s' "$capture_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$payment_admin_authorization" --data-binary @- \
      "$payment_url/v1/payments/$payment_id/capture" \
  | jq -e '.status == "captured" and .commission_amount == "24000"' >/dev/null

invoice_request=$(jq -nc --arg tenant "$tenant_id" --arg payment "$payment_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,payment_id:$payment,source_type:"marketplace_introduction",source_ref:$source,kind:"platform_commission",idempotency_key:("ci-invoice-"+$source),amount:{amount:"24000",currency:"USD",scale:2},description:"CI platform commission",billing_details:{title:"Integration recipient",tax_identifier:"CI-TAX-001",email:"recipient@example.invalid",registered_address_phone:null,bank_account:null},requested_by:"ci-operator"}')
invoice=$(printf '%s' "$invoice_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$payment_admin_authorization" --data-binary @- "$payment_url/v1/invoices")
invoice_id=$(jq -er '.invoice_id' <<<"$invoice")
test "$(jq -r '.status' <<<"$invoice")" = requested

curl --fail-with-body --silent --header 'content-type: application/json' \
  --header "$payment_admin_authorization" --data '{"actor":"ci-operator"}' \
  "$payment_url/v1/invoices/$invoice_id/issue" \
  | jq -e '.status == "issued" and .provider_mode == "test"' >/dev/null
curl --fail-with-body --silent --header "$payment_admin_authorization" \
  "$payment_url/v1/invoices/$invoice_id/download" \
  | jq -e '.test_mode == true and .kind == "platform_commission" and .amount.amount == "24000"' >/dev/null

refund_request=$(jq -nc --arg tenant "$tenant_id" --arg source "$introduction_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-refund-"+$source),amount:"12000",reason:"CI partial commission refund"}')
refund=$(printf '%s' "$refund_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$payment_admin_authorization" --data-binary @- \
      "$payment_url/v1/payments/$payment_id/refunds")
test "$(jq -r '.status' <<<"$refund")" = succeeded
test "$(jq -r '.commission_reversal_amount' <<<"$refund")" = 12000

corrections=$(curl --fail-with-body --silent --header "$payment_admin_authorization" \
  "$payment_url/v1/invoices/$invoice_id/corrections")
correction_id=$(jq -er '.[0].invoice_id' <<<"$corrections")
jq -e 'length == 1 and .[0].status == "red_letter_pending" and .[0].amount == "12000"' \
  <<<"$corrections" >/dev/null
curl --fail-with-body --silent --header 'content-type: application/json' \
  --header "$payment_admin_authorization" --data '{"actor":"ci-operator"}' \
  "$payment_url/v1/invoices/$correction_id/red-letter" \
  | jq -e '.status == "red_lettered"' >/dev/null
curl --fail-with-body --silent --header "$payment_admin_authorization" \
  "$payment_url/v1/invoices/$correction_id/download?artifact=credit_note" \
  | jq -e '.test_mode == true and .kind == "platform_commission" and .amount.amount == "12000"' >/dev/null

privacy_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT (SELECT bool_and(position(convert_to('supply@example.invalid', 'UTF8') in contact_ciphertext)=0) FROM marketplace_parties), (SELECT count(*) FROM marketplace_introduction_contact_events WHERE decision='denied'), (SELECT count(*) FROM marketplace_introduction_contact_events WHERE decision='allowed');")
test "$privacy_assertion" = 't|1|4'

echo 'MatchPlane generic marketplace smoke test passed'
