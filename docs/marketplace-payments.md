# Marketplace, offline deals, and payments

MatchPlane treats demand/supply discovery, contact exchange, and platform revenue as separate
concerns:

1. Supply participants publish schema-validated offers. Recommendation impressions, detail views,
   favorites, inquiries, and privacy-cleared contacts form an auditable exposure funnel.
2. Buyers store a narrative, structured requirements, and exact budget bounds. Recommendations are
   ranked by explainable attribute and budget fit; a rendered recommendation records an impression.
3. An introduction connects exactly one demand intent and one supply offer. The parties may exchange
   platform-configured contact channels and continue outside the platform. The primary monetization is a seller
   promotion/exposure fee; the platform never describes any fee as part of the offer price or as a
   hidden spread.

The market owns the revenue policy and collection rules. Sellers cannot lower a tenant's configured
promotion price. A `seller_promotion` policy charges for the selected exposure/lead event and does
not depend on a later off-platform transaction. An optional `preauthorized` transaction fee requires
the matched seller to authorize the disclosed fee before contact; `postpaid` permits contact first
but still requires captured fee before MatchPlane marks a transaction completed.

Seller promotion campaigns are created with `POST /v1/marketplace/promotions`. They target a
vertical-owned key (the vehicle adapter uses `vehicle_listing`) and choose `fixed`, `cpm`, `cpc`,
or `cpl` pricing. Recommendation/detail/inquiry/contact events are deduplicated and accrue spend
atomically against the campaign budget; campaign metrics are visible only to the sponsoring seller.

## Privacy and identity

`POST /v1/marketplace/parties` returns a high-entropy bearer token exactly once. PostgreSQL stores
only its SHA-256 digest. Party contact data is an encrypted, bounded map of platform-defined
channel names (phone, WeChat, QQ, email, or another configured channel); viewing locations use
AES-256-GCM with context-bound associated data. Production requires
`MATCHPLANE_CONTACT_DATA_KEY_FILE`. Every allowed or denied contact access is written to
`contact_access_audit`.

All later marketplace endpoints require `Authorization: Bearer <party token>` together with the
tenant and party IDs. A demand-side introduction is a contact request; the supply participant must
explicitly consent at `/v1/marketplace/introductions/{id}/contact/consent` before either side can
retrieve the other side's configured channels. The generic flow is
`POST .../contact/request`, `POST .../contact/consent`, then `GET .../contact`. A matched participant
receives only the counterpart contact, and a seller's token is required for legacy offline
commission payment; merely supplying a party UUID is insufficient.

## Offline lifecycle

```text
buyer request + seller listing
            |
      recommendation (seller impression)
            |
      offline deal proposed (seller inquiry)
            |
      seller accepts contact request
            |
  seller promotion event (impression / qualified lead)
            |
   audited counterpart contact release
            |
    encrypted-location viewing proposal
            |
     counterpart confirms viewing
            |
 buyer and seller confirm the same offline price
            |
 capture exact commission from final price
            |
 completed (listing sold, buyer request closed)
```

The buyer and seller can exchange the vehicle payment in person. The payment service processes only
the separately disclosed platform commission for an `offline_direct` deal. If the final price is
lower than the asking price, MatchPlane partially captures the earlier authorization and records the
actual commission. If it is higher, the seller must authorize sufficient commission before
completion.

The domain-neutral kernel is available before any vertical adapter is installed:

- `POST /v1/marketplace/intents`
- `GET /v1/marketplace/intents/{id}`
- `POST /v1/marketplace/intents/{id}/matches`
- `POST /v1/marketplace/offers`
- `POST /v1/admin/marketplace/offers/{id}/activate`
- `GET|POST /v1/marketplace/introductions`

These resources carry opaque domain `attributes` and `terms`; the automotive resources below are
compatibility adapters and are not required for a new subplatform.

Key compatibility gateway endpoints are:

- `POST /v1/marketplace/parties`
- `POST /v1/marketplace/listings`
- `POST /v1/marketplace/buyer-requests`
- `POST /v1/marketplace/buyer-requests/{id}/recommendations`
- `POST /v1/marketplace/offline-deals`
- `POST /v1/marketplace/offline-deals/{id}/contact/accept`
- `GET /v1/marketplace/offline-deals/{id}/contact`
- `GET|POST /v1/marketplace/offline-deals/{id}/viewings`
- `POST /v1/marketplace/viewings/{id}/{confirm|complete|cancel}`
- `POST /v1/marketplace/offline-deals/{id}/confirm`
- `POST /v1/marketplace/offline-deals/{id}/finalize`
- `GET /v1/marketplace/listings/{id}/exposure-metrics`
- `POST /v1/marketplace/promotions`
- `GET /v1/marketplace/promotions/{id}`
- `POST /v1/admin/marketplace/asset-authorizations`

Viewing appointment reads accept `limit` (default 50, maximum 50) and `offset` (default 0,
maximum 32). Each offline introduction accepts at most 32 appointment proposals; the deal row is
locked while the quota is checked so concurrent proposals cannot exceed the cap.
- Public detail/favorite telemetry is server-timestamped, deduplicated to one event per
  buyer/listing/day, and recorded as non-billable. Seller-funded campaign billing is derived
  only from server-observed recommendation, inquiry, match, and contact-exchange records.

## Isolated payment service

`matchplane-payment-service` owns payment intents, gateway configuration, mode changes, refunds,
invoices, provider artifacts, and payment audit history. It exposes a standard gateway trait and
built-in adapters for:

- deterministic test payments;
- EPay-compatible redirect payments;
- Waffo Pancake;
- WeChat Pay API v3 (Native, JSAPI, and H5);
- Alipay OpenAPI (desktop and mobile website payment);
- registered custom adapters.

Test and production configurations are separate. An administrator changes the active mode with an
optimistic version check. A switch is rejected unless the target mode has an enabled route and the
old mode has no unresolved payment outcomes. Production gateway credentials are read from restricted
files (or an external secret manager that materializes those files); environment-variable references
are accepted only in development and test profiles. Do not put
`MATCHPLANE_PAYMENT_GATEWAY_*`, `MATCHPLANE_PAYMENT_PROVIDER_*`, or
`MATCHPLANE_INVOICE_PROVIDER_*` credentials in the shared production environment file. Credentials
are not stored in the database. Each gateway stores a SHA-256 digest of the resolved secret
material and each payment snapshots that digest, so replacing a file or changing an environment
variable behind the same reference fails closed. Legacy production gateways without a digest must
be re-saved before they can authorize or accept callbacks.

Payment endpoints include authorization, manual capture, refunds, status reads, and invoice
management. An administrator can call the idempotent
`POST /v1/payments/{payment_id}/reconcile` endpoint to query the selected gateway after a missing
callback or an ambiguous network result. Reconciliation is durably recorded and stale provider
responses cannot downgrade a terminal payment. Invoice recipient data and generated artifacts are
encrypted. Partial or full refunds create separate correction invoice requests so the original
issued invoice remains immutable; the correction can then be issued as a red-letter/credit artifact.

Payment `purpose` values are opaque, bounded labels owned by the active subplatform. The generic
invoice sale kind is `sale`; historical `vehicle_purchase`/`vehicle_sale` rows are read through a
compatibility adapter and are not seeded by the root platform. `platform_commission` remains a
shared settlement purpose because it is the platform's revenue boundary, not a product category.

The isolated service is not a public anonymous payment API. Online authorization and every payment,
capture, refund, reconciliation, and invoice management/read operation require the administrator
bearer token and are intended for a trusted local orchestrator. The sole party-authenticated
exception is offline commission authorization, which requires the matched seller's one-time party
credential. Health endpoints remain unauthenticated for supervision.

In production, configure:

- `MATCHPLANE_INVOICE_DATA_KEY_FILE` with a 32-byte AES key;
- `MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE` with a random token of at least 24 bytes;
- `MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE` with a separate random token for the core gateway APIs;
- `MATCHPLANE_PAYMENT_CALLBACK_ORIGIN` with the platform-owned HTTPS origin used by payment
  provider return and notification URLs. Marketplace callers cannot select another origin;
- gateway-specific secret files referenced from administrator-created gateway configurations;
- the WeChat merchant ID, certificate serial, API v3 key, private key, and AppID after merchant
  onboarding;
- the Alipay application ID and RSA2 keys after signing the appropriate website payment product.

The administrator API is rooted at `/v1/admin/payment-*` and `/v1/admin/invoice-*` and requires the
payment administrator bearer token. Payment gateway and route mutations are version-checked and
audited. A gateway with payment history can only be disabled (without changing its pinned revision)
to revoke new routes and webhook acceptance; create a new gateway for credential rotation. Invoice
provider mutations are version-checked and audited without returning secret
references; switching the invoice mode preflights the selected provider, refuses local-test
providers in production, and refuses to switch while invoices are outstanding. The packaged
systemd deployment binds the payment API to `127.0.0.1:8081`; Compose publishes it on configurable
host port `MATCHPLANE_PAYMENT_HOST_PORT` (default `8081`).

The administrator list endpoints are bounded and newest-first: `GET /v1/admin/payments`,
`GET /v1/admin/refunds`, and `GET /v1/admin/invoices` accept `tenant_id`, `limit` (1–100), and
`offset` (capped at 100,000). They return operational metadata only; invoice billing details and
encrypted artifacts remain server-side. The web workspace exposes these lists through same-origin
server BFF routes, so the payment bearer never reaches the browser.

Invoice administration endpoints are:

- `GET|POST /v1/admin/invoice-providers?tenant_id=...` to list or version-update providers;
- `GET|POST /v1/admin/invoice-mode?tenant_id=...` to read or switch the active mode/provider.

Seller listings require an explicit operator authorization for the tenant/domain/asset/seller
tuple. Grant or revoke it with `POST /v1/admin/marketplace/asset-authorizations`; a seller token
cannot claim an arbitrary catalog asset.

Use `mode: "test", provider_key: "local_test"` for deterministic sandbox issuance. Production
uses `mode: "production"` with `provider_key: "http_json"` (or `"fapiao_http"`), an HTTPS
`settings.base_url`, and a `file:`/`env:` credential reference. Keep the reference itself out of
logs and source control; the service resolves it only while validating or issuing.

Invoice issuance is deliberately fail-closed until a real tax-invoice provider adapter is
configured. `local_test` only runs in test mode and produces deterministic sandbox artifacts; it
must never be selected for production issuance. Production tenants can use the `http_json` (or
`fapiao_http`) provider adapter. Its `invoice_provider_configs.settings` must contain an HTTPS
`base_url` and optional `issue_path`, `void_path`, and `red_letter_path`; its credential reference
must resolve to a bearer token. The provider must accept the documented JSON request and return
`provider_reference`, `invoice_number`, and an optional bounded `artifact` object with
`media_type` and base64 `content_base64`. The service encrypts the returned artifact before storing
it, and rejects missing references, malformed artifacts, non-HTTPS endpoints, and local-test
providers in production. This keeps vendor onboarding explicit while leaving the tax provider
contract replaceable.

Provider callbacks are received at
`POST /payments-api/v1/payment-webhooks/{production_gateway_id}`. EPay callbacks use MD5, Alipay
uses RSA2, WeChat Pay v3 uses platform RSA verification plus API-v3 AES-GCM resource decryption,
and Waffo uses its configured RSA public key. Every verified event is bound to the configured
gateway and merchant order, checked against the stored amount, deduplicated by provider event id,
and applied to the payment/refund state machine. Inbox rows are claimed before state application;
an active claim returns a retryable service-unavailable response, and a claim older than five
minutes can be reclaimed after a process crash. Claim tokens prevent a stale worker from finishing
over a newer retry. Provider references are also checked against the
merchant order/payment identity before mutation. Unknown or mismatched events are retained in the
inbox for audit and never mutate a payment. Successful EPay and Alipay callbacks receive the
provider-required plain-text `success` acknowledgement; WeChat receives `{"code":"SUCCESS"}` and
Waffo receives `{"code":"0"}`.
