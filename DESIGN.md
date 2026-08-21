# MatchPlane Design System

## Direction

MatchPlane is a modern, browseable marketplace. The public experience combines a familiar store-and-product catalogue with one useful AI shopping conversation. It should feel easy to shop, not like infrastructure software, an art poster, or an AI demonstration.

The first viewport is product-first. When published products exist, real images, prices, attributes, and store ownership appear immediately after a compact search assistant. Brand theatre and oversized store containers never delay the catalogue.

The structural reference is a contemporary commerce landing page: quiet top navigation, clear hero copy, a primary shopping input, a live store showcase, and a card-based product result grid. MatchPlane keeps its own black, ivory, paper, cactus, and clay identity.

## Product hierarchy

1. Browse real stores and products.
2. Describe a need for cross-store assistance.
3. Compare products and trade-offs.
4. Sign in only for durable actions such as saving, contact, ordering, or opening a store.
5. Enter the merchant center for store, product, team, notification, matching, and contact workflows that are genuinely available.

## Visual system

- Ink: #141413
- Ivory: #FAF9F5
- Paper: #F0EEE6
- Cactus: #BCD1CA
- Clay: #D97757
- Lines use translucent Ink rather than unrelated gray.
- Cactus may own a large background field. Clay is reserved for a current action or small status.
- No purple gradients, neon glows, technical grids, logistics forms, or dashboard decoration on public pages.

Typography keeps the incumbent Avenir/SF/PingFang family. Public headings use strong but not compressed weights, natural Chinese wrapping, and no display tracking below -0.02em. Body copy remains 16px or larger on reading surfaces.

## Components

### Store cards

- Every card links to a real active store.
- The first store may receive a larger feature card; the remaining stores stay fully browseable in a compact list.
- When no store exists, show an explicit empty state rather than sample inventory.
- Store initials are a fallback identity, not a fabricated logo.

### Product cards

- Use real product images, title, store, price, attributes, reasons, and consent-aware actions.
- Cards use one elevation cue: either a border or a shadow.
- The entire product can be opened from its image or title; save, dismiss, and compare remain separate actions.

### Shopping input

- The conversation remains the primary assisted-shopping action.
- On a populated marketplace it is a compact catalogue search header, not the dominant hero.
- Suggestion chips only fill the textarea. They never claim that search or purchase succeeded.
- Sending, loading, empty, error, and conversation states remain explicit.

### Merchant workspace

- Existing real tasks are grouped as products, store, team, notifications, demand matching, submission history, and contact requests.
- Product management opens on the catalogue, with one clear Publish product action; the editor collects image, category, description, price, delivery mode, and stock.
- Internal domain identifiers never appear as a merchant-facing product-range concept.
- Remote-store invite expiry applies only to the one-time connection link. Connected stores are persistent and show health state instead.
- Model reasoning controls are capability-driven per model; unsupported models receive no generic reasoning parameter.
- Payment, order, wallet, or after-sales controls appear only after their APIs and authorization are implemented.
- Navigation names tasks directly and preserves keyboard tab semantics.

## Responsive behavior

- Desktop hero: copy and input on the left, store cards on the right.
- Tablet: store showcase follows the shopping input.
- Mobile: navigation compresses, store cards become one column, and product results use one column.
- All important actions remain usable at 320px.

## Motion

Use one short orchestrated store-card arrival and immediate press feedback. Product and dialog transitions begin from the current presentation value, remain interruptible, and reduce to cross-fades under reduced-motion preferences.
