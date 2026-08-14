#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
compose=(docker compose --env-file "$repository_root/.env.example" -f "$repository_root/deploy/compose/compose.yaml")
base_url=${MATCHPLANE_BASE_URL:-http://127.0.0.1:8080}
payment_url=${MATCHPLANE_PAYMENT_BASE_URL:-http://127.0.0.1:8081}
tenant_id=00000000-0000-7000-8000-000000000100
domain_id=00000000-0000-7000-8000-000000000101
asset_id=00000000-0000-7000-8000-000000000601
campaign_id=00000000-0000-7000-8000-000000000901
admin_authorization='authorization: Bearer matchplane-development-admin'

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

seller=$(jq -nc --arg tenant "$tenant_id" \
  '{tenant_id:$tenant,external_key:"ci-seller",display_name:"CI Seller",role:"seller",contact:{phone:"13800000001",wechat:"ci_seller"}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' --data-binary @- \
      "$base_url/v1/marketplace/parties")
seller_id=$(jq -er '.party_id' <<<"$seller")
seller_token=$(jq -er '.access_token' <<<"$seller")

buyer=$(jq -nc --arg tenant "$tenant_id" \
  '{tenant_id:$tenant,external_key:"ci-buyer",display_name:"CI Buyer",role:"buyer",contact:{phone:"13800000002",wechat:"ci_buyer"}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' --data-binary @- \
      "$base_url/v1/marketplace/parties")
buyer_id=$(jq -er '.party_id' <<<"$buyer")
buyer_token=$(jq -er '.access_token' <<<"$buyer")

jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg asset "$asset_id" \
  --arg seller "$seller_id" \
  '{tenant_id:$tenant,domain_id:$domain,asset_id:$asset,seller_party_id:$seller,enabled:true,authorized_by:"ci-admin",reason:"integration smoke seller authorization"}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer matchplane-development-gateway-admin" --data-binary @- \
      "$base_url/v1/admin/marketplace/asset-authorizations" \
  | jq -e --arg seller "$seller_id" '.status == "active" and .seller_party_id == $seller' >/dev/null

listing=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg asset "$asset_id" \
  --arg seller "$seller_id" \
  '{tenant_id:$tenant,domain_id:$domain,asset_id:$asset,seller_party_id:$seller,asking_amount:"2500000",currency:"USD",currency_scale:2}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $seller_token" --data-binary @- \
      "$base_url/v1/marketplace/listings")
listing_id=$(jq -er '.listing_id' <<<"$listing")
test "$(jq -r '.commission_bps' <<<"$listing")" = 100
test "$(jq -r '.commission_collection' <<<"$listing")" = postpaid

promotion=$(jq -nc --arg tenant "$tenant_id" --arg seller "$seller_id" --arg target "$listing_id" \
  '{campaign_id:"00000000-0000-7000-8000-000000000901",tenant_id:$tenant,sponsor_party_id:$seller,target_kind:"vehicle_listing",target_key:$target,policy:"seller_promotion",pricing_model:"cpl",currency:"USD",currency_scale:2,unit_price:"5000",budget_amount:"100000",settings:{surface:"ai_recommendation"}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $seller_token" --data-binary @- \
      "$base_url/v1/marketplace/promotions")
test "$(jq -r '.status' <<<"$promotion")" = active

buyer_request=$(jq -nc --arg tenant "$tenant_id" --arg domain "$domain_id" --arg buyer "$buyer_id" \
  '{tenant_id:$tenant,domain_id:$domain,buyer_party_id:$buyer,narrative:"CI buyer requirements",requirements:{make:"MatchPlane",model_year:2026},budget_min:"2000000",budget_max:"3000000",currency:"USD",currency_scale:2}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $buyer_token" --data-binary @- \
      "$base_url/v1/marketplace/buyer-requests")
request_id=$(jq -er '.request_id' <<<"$buyer_request")

recommendations=$(jq -nc --arg tenant "$tenant_id" --arg buyer "$buyer_id" \
  '{tenant_id:$tenant,buyer_party_id:$buyer,exposure_key:"ci-page-1",limit:10}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $buyer_token" --data-binary @- \
      "$base_url/v1/marketplace/buyer-requests/$request_id/recommendations")
jq -e --arg listing "$listing_id" \
  'length == 1 and .[0].listing_id == $listing and .[0].match_score == 1' \
  <<<"$recommendations" >/dev/null

deal=$(jq -nc --arg tenant "$tenant_id" --arg listing "$listing_id" --arg request "$request_id" \
  --arg buyer "$buyer_id" \
  '{tenant_id:$tenant,listing_id:$listing,buyer_request_id:$request,buyer_party_id:$buyer}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $buyer_token" --data-binary @- \
      "$base_url/v1/marketplace/offline-deals")
deal_id=$(jq -er '.offline_deal_id' <<<"$deal")

contact_before_seller_consent=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer $buyer_token" \
  "$base_url/v1/marketplace/offline-deals/$deal_id/contact?tenant_id=$tenant_id&party_id=$buyer_id")
test "$contact_before_seller_consent" = 409

curl --fail-with-body --silent --header "authorization: Bearer $seller_token" \
  "$base_url/v1/marketplace/offline-deals?tenant_id=$tenant_id&party_id=$seller_id" \
  | jq -e --arg deal "$deal_id" 'length == 1 and .[0].offline_deal_id == $deal' >/dev/null

curl --fail-with-body --silent --header 'content-type: application/json' \
  --header "authorization: Bearer $seller_token" \
  --data "{\"tenant_id\":\"$tenant_id\",\"party_id\":\"$seller_id\"}" \
  "$base_url/v1/marketplace/offline-deals/$deal_id/contact/accept" \
  | jq -e '.seller_contact_consent_at != null' >/dev/null

contact_after_seller_consent=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "authorization: Bearer $buyer_token" \
  "$base_url/v1/marketplace/offline-deals/$deal_id/contact?tenant_id=$tenant_id&party_id=$buyer_id")
test "$contact_after_seller_consent" = 200

contact=$(curl --fail-with-body --silent --header "authorization: Bearer $buyer_token" \
  "$base_url/v1/marketplace/offline-deals/$deal_id/contact?tenant_id=$tenant_id&party_id=$buyer_id")
test "$(jq -r '.counterpart.party_id' <<<"$contact")" = "$seller_id"
test "$(jq -r '.counterpart.contact.phone' <<<"$contact")" = 13800000001
test "$(jq -r '.counterpart.contact.wechat' <<<"$contact")" = ci_seller
test "$(jq -r '.vehicle_settlement' <<<"$contact")" = offline_direct_between_buyer_and_seller

seller_contact=$(curl --fail-with-body --silent --header "authorization: Bearer $seller_token" \
  "$base_url/v1/marketplace/offline-deals/$deal_id/contact?tenant_id=$tenant_id&party_id=$seller_id")
test "$(jq -r '.counterpart.party_id' <<<"$seller_contact")" = "$buyer_id"
test "$(jq -r '.counterpart.contact.phone' <<<"$seller_contact")" = 13800000002
test "$(jq -r '.counterpart.contact.wechat' <<<"$seller_contact")" = ci_buyer

payment_request=$(jq -nc --arg tenant "$tenant_id" --arg deal "$deal_id" --arg seller "$seller_id" \
  '{tenant_id:$tenant,offline_deal_id:$deal,payer_party_id:$seller,merchant_order_id:("ci-offline-commission-"+$deal),idempotency_key:("ci-authorize-"+$deal),transaction_channel:"offline_direct",purpose:"platform_commission",amount:{amount:"25000",currency:"USD",scale:2},commission_amount:"25000",method:"card",notify_url:"https://example.invalid/payment-notify",return_url:"https://example.invalid/payment-return",description:"CI offline commission"}')
unauthenticated_payment=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --data "$payment_request" \
  "$payment_url/v1/payments/authorize")
wrong_party_payment=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --header "authorization: Bearer $buyer_token" \
  --data "$payment_request" "$payment_url/v1/payments/authorize")
test "$unauthenticated_payment" = 401
test "$wrong_party_payment" = 401

payment=$(curl --fail-with-body --silent --header 'content-type: application/json' \
  --header "authorization: Bearer $seller_token" --data "$payment_request" \
  "$payment_url/v1/payments/authorize")
payment_id=$(jq -er '.payment_id' <<<"$payment")
test "$(jq -r '.status' <<<"$payment")" = authorized

reconciliation_request=$(jq -nc --arg tenant "$tenant_id" --arg deal "$deal_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-reconcile-"+$deal)}')
reconciliation=$(curl --fail-with-body --silent --header 'content-type: application/json' \
  --header 'authorization: Bearer matchplane-development-admin' \
  --data "$reconciliation_request" "$payment_url/v1/payments/$payment_id/reconcile")
jq -e '.status == "authorized" and .duplicate == false' <<<"$reconciliation" >/dev/null
curl --fail-with-body --silent --header 'content-type: application/json' \
  --header 'authorization: Bearer matchplane-development-admin' \
  --data "$reconciliation_request" "$payment_url/v1/payments/$payment_id/reconcile" \
  | jq -e '.status == "authorized" and .duplicate == true' >/dev/null

contact=$(curl --fail-with-body --silent --header "authorization: Bearer $buyer_token" \
  "$base_url/v1/marketplace/offline-deals/$deal_id/contact?tenant_id=$tenant_id&party_id=$buyer_id")
test "$(jq -r '.counterpart.party_id' <<<"$contact")" = "$seller_id"
test "$(jq -r '.counterpart.contact.phone' <<<"$contact")" = 13800000001
test "$(jq -r '.counterpart.contact.wechat' <<<"$contact")" = ci_seller
test "$(jq -r '.vehicle_settlement' <<<"$contact")" = offline_direct_between_buyer_and_seller

starts_at=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ')
ends_at=$(date -u -d '+2 hours' '+%Y-%m-%dT%H:%M:%SZ')
viewing=$(jq -nc --arg tenant "$tenant_id" --arg buyer "$buyer_id" --arg start "$starts_at" \
  --arg end "$ends_at" \
  '{tenant_id:$tenant,proposed_by:$buyer,starts_at:$start,ends_at:$end,location:{address:"CI inspection center",note:"front desk"}}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $buyer_token" --data-binary @- \
      "$base_url/v1/marketplace/offline-deals/$deal_id/viewings")
viewing_id=$(jq -er '.viewing_id' <<<"$viewing")
test "$(jq -r '.location.address' <<<"$viewing")" = 'CI inspection center'

jq -nc --arg tenant "$tenant_id" --arg seller "$seller_id" '{tenant_id:$tenant,party_id:$seller}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $seller_token" --data-binary @- \
      "$base_url/v1/marketplace/viewings/$viewing_id/confirm" \
  | jq -e '.status == "confirmed"' >/dev/null

jq -nc --arg tenant "$tenant_id" --arg buyer "$buyer_id" \
  '{tenant_id:$tenant,party_id:$buyer,final_amount:"2400000"}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $buyer_token" --data-binary @- \
      "$base_url/v1/marketplace/offline-deals/$deal_id/confirm" \
  | jq -e '.next_action == "counterparty_confirmation"' >/dev/null

jq -nc --arg tenant "$tenant_id" --arg seller "$seller_id" \
  '{tenant_id:$tenant,party_id:$seller,final_amount:"2400000"}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $seller_token" --data-binary @- \
      "$base_url/v1/marketplace/offline-deals/$deal_id/confirm" \
  | jq -e '.next_action == "capture_platform_commission" and .commission_amount == "24000"' >/dev/null

capture_request=$(jq -nc --arg tenant "$tenant_id" --arg deal "$deal_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-capture-"+$deal),amount:"24000"}')
unauthenticated_capture=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --data "$capture_request" \
  "$payment_url/v1/payments/$payment_id/capture")
test "$unauthenticated_capture" = 401
printf '%s' "$capture_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$admin_authorization" --data-binary @- \
      "$payment_url/v1/payments/$payment_id/capture" \
  | jq -e '.status == "captured" and .commission_amount == "24000"' >/dev/null

jq -nc --arg tenant "$tenant_id" --arg buyer "$buyer_id" '{tenant_id:$tenant,party_id:$buyer}' \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "authorization: Bearer $buyer_token" --data-binary @- \
      "$base_url/v1/marketplace/offline-deals/$deal_id/finalize" \
  | jq -e '.status == "completed" and .next_action == "completed"' >/dev/null

invoice_request=$(jq -nc --arg tenant "$tenant_id" --arg payment "$payment_id" --arg deal "$deal_id" \
  '{tenant_id:$tenant,payment_id:$payment,offline_deal_id:$deal,kind:"platform_commission",idempotency_key:("ci-invoice-"+$deal),amount:{amount:"24000",currency:"USD",scale:2},description:"CI platform commission",billing_details:{title:"CI Seller Ltd",tax_identifier:"CI-TAX-001",email:"seller@example.invalid",registered_address_phone:null,bank_account:null},requested_by:"ci-seller"}')
unauthenticated_invoice=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --data "$invoice_request" "$payment_url/v1/invoices")
test "$unauthenticated_invoice" = 401
invoice=$(printf '%s' "$invoice_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$admin_authorization" --data-binary @- "$payment_url/v1/invoices")
invoice_id=$(jq -er '.invoice_id' <<<"$invoice")
test "$(jq -r '.status' <<<"$invoice")" = requested

curl --fail-with-body --silent --header 'content-type: application/json' \
  --header 'authorization: Bearer matchplane-development-admin' \
  --data '{"actor":"ci-admin"}' "$payment_url/v1/invoices/$invoice_id/issue" \
  | jq -e '.status == "issued" and .provider_mode == "test"' >/dev/null
curl --fail-with-body --silent \
  --header 'authorization: Bearer matchplane-development-admin' \
  "$payment_url/v1/invoices/$invoice_id/download" \
  | jq -e '.test_mode == true and .kind == "platform_commission" and .amount.amount == "24000"' >/dev/null

refund_request=$(jq -nc --arg tenant "$tenant_id" --arg deal "$deal_id" \
  '{tenant_id:$tenant,idempotency_key:("ci-refund-"+$deal),amount:"12000",reason:"CI partial commission refund"}')
unauthenticated_refund=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --data "$refund_request" \
  "$payment_url/v1/payments/$payment_id/refunds")
test "$unauthenticated_refund" = 401
refund=$(printf '%s' "$refund_request" \
  | curl --fail-with-body --silent --header 'content-type: application/json' \
      --header "$admin_authorization" --data-binary @- \
      "$payment_url/v1/payments/$payment_id/refunds")
test "$(jq -r '.status' <<<"$refund")" = succeeded
test "$(jq -r '.commission_reversal_amount' <<<"$refund")" = 12000

corrections=$(curl --fail-with-body --silent \
  --header "$admin_authorization" \
  "$payment_url/v1/invoices/$invoice_id/corrections")
correction_id=$(jq -er '.[0].invoice_id' <<<"$corrections")
jq -e 'length == 1 and .[0].status == "red_letter_pending" and .[0].amount == "12000"' \
  <<<"$corrections" >/dev/null
curl --fail-with-body --silent --header 'content-type: application/json' \
  --header 'authorization: Bearer matchplane-development-admin' \
  --data '{"actor":"ci-admin"}' "$payment_url/v1/invoices/$correction_id/red-letter" \
  | jq -e '.status == "red_lettered"' >/dev/null
curl --fail-with-body --silent \
  --header 'authorization: Bearer matchplane-development-admin' \
  "$payment_url/v1/invoices/$correction_id/download?artifact=credit_note" \
  | jq -e '.test_mode == true and .kind == "platform_commission" and .amount.amount == "12000"' >/dev/null

curl --fail-with-body --silent --header "authorization: Bearer $seller_token" \
  "$base_url/v1/marketplace/listings/$listing_id/exposure-metrics?tenant_id=$tenant_id&party_id=$seller_id" \
  | jq -e '.impressions == 1 and .inquiries == 1 and .matched_contacts == 1' >/dev/null

promotion_metrics=$(curl --fail-with-body --silent --header "authorization: Bearer $seller_token" \
  "$base_url/v1/marketplace/promotions/$campaign_id?tenant_id=$tenant_id&party_id=$seller_id")
jq -e '.status == "active" and .billable_units == 1 and .spent_amount == "5000"' \
  <<<"$promotion_metrics" >/dev/null

privacy_assertion=$("${compose[@]}" exec -T postgres psql --username matchplane --dbname matchplane \
  --tuples-only --no-align --command \
  "SELECT bool_and(position(convert_to('138000000', 'UTF8') in contact_ciphertext)=0), (SELECT bool_and(position(convert_to('CI inspection center', 'UTF8') in location_ciphertext)=0) FROM viewing_appointments), (SELECT bool_and(position(convert_to('CI Seller Ltd', 'UTF8') in billing_details_ciphertext)=0) FROM invoice_requests), (SELECT count(*) FROM contact_access_audit WHERE decision='denied'), (SELECT count(*) FROM contact_access_audit WHERE decision='allowed') FROM marketplace_parties;")
test "$privacy_assertion" = 't|t|t|1|4'

echo 'MatchPlane offline marketplace smoke test passed'
