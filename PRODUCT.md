# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js with Bun for the customer and operator web surfaces, Rust for the gateway and commerce
kernel, PostgreSQL for durable state, Better Auth for identity, and bounded MCP/Skill contracts
for store integrations and AI tools.

## Users

- Visitors who browse stores and products or ask the shopping assistant for help without signing
  in.
- Customers who create an account only when they want to save, contact a store, or buy.
- Merchants who open stores, publish products, and handle customer enquiries.
- Marketplace owners and marketplace operators who configure the marketplace, review stores and
  products, and manage billing, identity, policy, and integrations.
- External store systems and Agents that expose bounded catalog, retrieval, or fulfilment tools.

## Product Purpose

MatchPlane is an AI-native marketplace. A visitor describes what they want, and the marketplace
shopping assistant searches approved stores, presents real product images, compares prices and
trade-offs, and helps calculate a suitable basket. Browsing and AI-assisted discovery are public;
identity is required only for actions that create durable personal or commercial state.

## Positioning

The product has exactly two commercial layers:

1. **Marketplace** — the public shopping entrance, configurable brand, shared identity, AI shopping
   assistant, cross-store search and comparison, consent, checkout hooks, billing, and audit.
2. **Store** — one merchant-facing storefront and catalog, either hosted inside MatchPlane or
   connected from an external system through a reviewed integration.

Stores never contain other stores. The database may retain older organization and platform fields
for compatibility, but new product behavior must not expose or create a recursive platform tree.

## Operating Context

The marketplace is served at `/`. Active stores use one-segment paths such as `/store-a` and are
also discoverable from the marketplace assistant. A hosted store uses the shared product editor;
an integrated store may supply its own storefront, catalog retrieval, media, and fulfilment tools.
Both types remain ordinary stores in the public experience. Catalogs are empty by default: MatchPlane does not seed merchant products or copy third-party listings. A signed-in merchant enters product details and images through the store editor; the product becomes public only after platform review.

Better Auth owns accounts and sessions. A single account can browse, buy, open a store, and publish
products; buyer and seller are actions, not account types. Store and marketplace permissions remain
server-side roles, while customer-facing copy uses plain names such as “店主”, “商城负责人”, and
“商城运营”.

## Capabilities and Constraints

- Every active store is a direct child of the marketplace root. New registrations cannot choose a
  store as their parent.
- Public catalog results contain product and store information only. Contact details, private
  identities, credentials, and unpublished products never enter public AI prompts or results.
- Every product has a stable public core: name, description, at least one product image, price,
  currency, store, lifecycle state, and optional category-specific attributes.
- AI may select stores, rank products, explain differences, and calculate totals. It cannot grant
  contact access, authorize payment, publish a product, or change permissions.
- Product comparison uses normalized price/currency and explicit attributes. Paid placement must
  be labelled and cannot silently replace organic relevance.
- Store integrations own their external catalog and retrieval implementation behind bounded MCP or
  HTTP contracts. The marketplace verifies scope, result shape, lifecycle, and commercial policy.
- Browsing and bounded shopping assistance work without login. Saving, contacting, ordering,
  opening a store, and publishing require a valid account.
- New account registration requires explicit acceptance of the marketplace's current public Terms
  of Service and Privacy Policy; the accepted document versions are retained server-side.
- Payment is optional. A marketplace may begin with consent-gated contact exchange and later enable
  checkout providers.
- Merchant monetization may combine store subscription, active-listing fees, clearly labelled paid
  exposure, and transaction service fees. Each charge must be configured, auditable, and disclosed.
- MIT licensing is required for repository-owned code.

## Brand Commitments

The marketplace name is configurable; MatchPlane is the underlying product. The interface is
clean, restrained, image-led where real products exist, and centered on one useful conversation.
It should feel like a modern marketplace rather than infrastructure management software. Product
and store content must come from real approved records; the root never fabricates inventory.

## Evidence on Hand

- Marketplace web application: `web/`.
- Rust services and shared commerce/storage crates: `services/` and `crates/`.
- Store integration contract: `docs/subplatform-contract.md`; store packages are maintained independently.
- HTTP MCP facade and Agent handoff: `web/app/api/mcp/` and
  `web/app/api/platform/agent/handoff/`.

## Product Principles

1. One marketplace, one flat store directory, no recursive commercial hierarchy.
2. Let people browse and ask for help first; request an account at the first durable action.
3. Make AI useful throughout discovery, comparison, calculation, and handoff while keeping
   authority in explicit authenticated actions.
4. Treat every merchant as a store and every active offer as a product with a clear owner.
5. Make merchant onboarding simple for hosted stores and bounded for external integrations.
6. Earn marketplace revenue transparently without corrupting organic recommendations.

## Accessibility & Inclusion

Chat, store navigation, product comparison, authentication, and merchant tools must be keyboard
reachable, screen-reader labelled, focus-visible, and usable from 320px through desktop layouts.
Images require useful alternative text. Loading, empty, error, authentication, sponsored, and
consent states must be explicit rather than communicated only through color or motion.
