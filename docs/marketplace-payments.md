# Marketplace, offline deals, and payments

MatchPlane treats demand/supply discovery, contact exchange, and platform revenue as separate
concerns:

1. Supply participants publish schema-validated offers. Recommendation impressions, detail views,
   favorites, inquiries, and privacy-cleared contacts form an auditable exposure funnel.
2. Buyers store a narrative, structured requirements, and exact budget bounds. Recommendations are
   ranked by explainable attribute and budget fit; a rendered recommendation records an impression.
3. An introduction connects exactly one demand intent and one supply offer. The parties may exchange
   phone/WeChat details and continue outside the platform. The primary monetization is a seller
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
only its SHA-256 digest. Party contact data is restricted to a phone number and/or WeChat ID;
viewing locations use AES-256-GCM with context-bound associated data. Production requires
`MATCHPLANE_CONTACT_DATA_KEY_FILE`. Every allowed or denied contact access is written to
`contact_access_audit`.

All later marketplace endpoints require `Authorization: Bearer <party token>` together with the
tenant and party IDs. A buyer's introduction is a contact request; the seller must explicitly accept
the request at `/v1/marketplace/offline-deals/{id}/contact/accept` before either side can retrieve
the other side's phone/WeChat details. A matched buyer receives only the seller contact, and the
seller receives only the buyer contact. A seller's token is also required when creating an offline
commission payment; merely supplying the seller UUID is insufficient.

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

Key gateway endpoints are:

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
- Promotion billing events are derived internally from authenticated listing exposure,
  inquiry, match, and contact-exchange records. There is intentionally no public
  `POST /v1/marketplace/promotions/{id}/events` endpoint: a buyer must not be able to
  manufacture a seller's billable campaign activity.

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
files or explicitly allow-listed `MATCHPLANE_PAYMENT_*` environment variables; they are not stored in
the database.

Payment endpoints include authorization, manual capture, refunds, status reads, and invoice
management. An administrator can call the idempotent
`POST /v1/payments/{payment_id}/reconcile` endpoint to query the selected gateway after a missing
callback or an ambiguous network result. Reconciliation is durably recorded and stale provider
responses cannot downgrade a terminal payment. Invoice recipient data and generated artifacts are
encrypted. Partial or full refunds create separate correction invoice requests so the original
issued invoice remains immutable; the correction can then be issued as a red-letter/credit artifact.

The isolated service is not a public anonymous payment API. Online authorization and every payment,
capture, refund, reconciliation, and invoice management/read operation require the administrator
bearer token and are intended for a trusted local orchestrator. The sole party-authenticated
exception is offline commission authorization, which requires the matched seller's one-time party
credential. Health endpoints remain unauthenticated for supervision.

In production, configure:

- `MATCHPLANE_INVOICE_DATA_KEY_FILE` with a 32-byte AES key;
- `MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE` with a random token of at least 24 bytes;
- `MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE` with a separate random token for the core gateway APIs;
- gateway-specific secret files referenced from administrator-created gateway configurations;
- the WeChat merchant ID, certificate serial, API v3 key, private key, and AppID after merchant
  onboarding;
- the Alipay application ID and RSA2 keys after signing the appropriate website payment product.

The administrator API is rooted at `/v1/admin/payment-*` and requires the payment administrator
bearer token. The packaged systemd deployment binds the payment API to `127.0.0.1:8081`; Compose
publishes it on configurable host port `MATCHPLANE_PAYMENT_HOST_PORT` (default `8081`).
