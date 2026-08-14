# Marketplace, offline deals, and payments

MatchPlane treats vehicle discovery, vehicle settlement, and platform commission as three separate
concerns:

1. Sellers publish schema-validated vehicles. Recommendation impressions, detail views, favorites,
   inquiries, and privacy-cleared contacts form an auditable exposure funnel.
2. Buyers store a narrative, structured requirements, and exact budget bounds. Recommendations are
   ranked by explainable attribute and budget fit; a rendered recommendation records an impression.
3. An offline introduction connects exactly one listing and buyer request. Vehicle funds can move
   directly between buyer and seller. The platform never describes its commission as part of the
   vehicle price or as a hidden spread.

The market owns the commission rate and collection policy. Sellers cannot lower the rate on a
listing. The default `preauthorized` policy requires the matched seller to authorize the disclosed
commission before either side can retrieve the other's contact. `postpaid` permits contact first but
still requires captured commission before MatchPlane marks the deal completed.

## Privacy and identity

`POST /v1/marketplace/parties` returns a high-entropy bearer token exactly once. PostgreSQL stores
only its SHA-256 digest. Contact records and viewing locations use AES-256-GCM with context-bound
associated data; production requires `MATCHPLANE_CONTACT_DATA_KEY_FILE`. Every allowed or denied
contact access is written to `contact_access_audit`.

All later marketplace endpoints require `Authorization: Bearer <party token>` together with the
tenant and party IDs. A matched buyer receives only the seller contact, and the seller receives only
the buyer contact. A seller's token is also required when creating an offline commission payment;
merely supplying the seller UUID is insufficient.

## Offline lifecycle

```text
buyer request + seller listing
            |
      recommendation (seller impression)
            |
      offline deal proposed (seller inquiry)
            |
  seller commission preauthorization [default]
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
- `GET /v1/marketplace/offline-deals/{id}/contact`
- `GET|POST /v1/marketplace/offline-deals/{id}/viewings`
- `POST /v1/marketplace/viewings/{id}/{confirm|complete|cancel}`
- `POST /v1/marketplace/offline-deals/{id}/confirm`
- `POST /v1/marketplace/offline-deals/{id}/finalize`
- `GET /v1/marketplace/listings/{id}/exposure-metrics`

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
- gateway-specific secret files referenced from administrator-created gateway configurations;
- the WeChat merchant ID, certificate serial, API v3 key, private key, and AppID after merchant
  onboarding;
- the Alipay application ID and RSA2 keys after signing the appropriate website payment product.

The administrator API is rooted at `/v1/admin/payment-*` and requires the payment administrator
bearer token. The packaged systemd deployment binds the payment API to `127.0.0.1:8081`; Compose
publishes it on configurable host port `MATCHPLANE_PAYMENT_HOST_PORT` (default `8081`).
