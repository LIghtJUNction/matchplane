---
name: "matchplane-practical-marketplace"
component_source:
  primary: "@appica/ui-react"
  secondary: "in-house"
provenance:
  method: "user-directed frontend refactor; source-backed baseline"
  source_paths:
    - "web/src/retail-ui.css"
    - "web/src/root-marketplace.css"
    - "web/src/components/MarketplaceHome.tsx"
    - "web/src/components/CatalogFilters.tsx"
    - "web/src/components/MarketplaceListingCard.tsx"
    - "web/src/components/StorefrontView.tsx"
    - "web/src/components/LoginScreen.tsx"
    - "web/src/components/shell/PlatformHeader.tsx"
confirmed_intent: "简约、好看、实用第一；借鉴瓜子的选购体验，不复制其品牌或车辆业务。"
tokens:
  color:
    background: "--retail-canvas"
    surface: "--retail-surface"
    text: "--retail-ink"
    secondaryText: "--retail-muted"
    primary: "--retail-accent"
    primaryForeground: "--retail-accent-contrast"
    border: "--retail-line"
    price: "--retail-price"
    focus: "--retail-focus"
  radius:
    small: "--radius-small"
    medium: "--radius-medium"
    large: "--radius-large"
  typography:
    display: "--retail-display"
    mono: "--retail-mono"
  shadow:
    small: "--shadow-small"
    large: "--shadow-large"
---

# MatchPlane frontend

## Direction

A practical multi-category marketplace, not a marketing landing page. A compact
AI request entry leads into real products and real stores. Product images, price
and relevant facts carry the page. The Guazi reference is an information-design
analogy, not a license to copy its identity, inventory, assurances or car fields.

Use neutral white/gray surfaces and dark, readable text. The default `moss`
palette uses `#16804a` for actions on a `#f5f7f6` canvas and white surfaces. Prices
have one warm accent. Do not scatter primary color across unrelated decoration.

## Public hierarchy

1. Shared navigation: brand, browse-products link, real store menu, preferences
   and the existing account menu. Administrative actions stay permission-gated.
2. One primary AI need-description entry. Keep drafts, source trace and real
   assistant feedback; do not introduce a competing promotional CTA.
3. Loaded-catalog browsing: product/store/location keywords, actual category
   values, result count, reset, and default/canonical-price sorting.
4. Product cards: 4:3 image, title, concise store-provided facts, price and source.
   Like and open remain separate actions. Missing images are explicitly labeled.
5. Existing detail/contact drawers and the real store directory.

Generic storefronts share the filter and card components. A store that is not
open must not expose inventory or advice merely because its shell was restyled.
Owned plugin content retains its integration boundary.

## Data and interaction rules

- Filters operate on the **loaded catalog**, and say so. Cross-store retrieval
  remains the AI assistant's job.
- Never parse a localized display price for sorting. Compare canonical integer
  amounts and scales exactly; do not convert currencies. Unknown prices go last,
  and incompatible prices cannot be sorted as though they were comparable.
- Category selection and text search must keep WebMCP's visible-offer boundary
  synchronized with the actual page. Use stable, non-empty Toggle identifiers.
- Distinguish loading, slow loading, failure, genuinely empty inventory and an
  empty filtered result. Every recoverable condition has a next action.
- Preserve keyboard operation, focus rings, Escape dismissal and focus return.
  Hover is supplementary, not the only path to an action.
- Keep authentication, draft restoration, management permissions and explicit
  contact-consent contracts unchanged.

## Components and CSS ownership

Use Appica primitives where already adopted. `CatalogFilters` combines an Appica
Input, ToggleGroup/Toggle and Buttons with a labeled native select. Filter chips
are selections, not status badges; result counts are live status text.

`retail-ui.css` owns the shared tokens, legacy-token bridge, navigation, cards,
store shells, authentication and management surfaces. `root-marketplace.css`
owns the public-root layout and shared catalog-filter/grid layout.
`retail-polish.css` retains the existing workspace/recovery refinements.
Do not add another override file to fight the existing layers; remove conflicting
legacy declarations when replacing a component's presentation.

Login introduction is real, localized DOM, not generated CSS content. Keep the
form usable at narrow widths instead of retaining two minimum-width columns.

## Responsive, preferences and motion

The root uses a bounded desktop width, a two-column request area and a four-column
catalog. It becomes a single request column and a two-column catalog on phones.
Category choices scroll within their own row, not the whole document. Keep touch
actions around 44 CSS px and phone form text at 16 px to avoid focus zoom.

Support Chinese/English, light/dark, five palettes and all existing text sizes.
Default to moss consistently in the server markup, initialization script and
preference hook, without replacing saved ink/clay/plum/amber choices.

Use installed system fonts. Avoid ambient animation, repeated card entrances,
image hover zoom and header blur. Reduced motion removes non-essential animation
and transitions. Do not introduce external fonts, fake product images, background
video or a decorative canvas for this marketplace.

## Verification

Check real interaction behavior, not just JSX snapshots. Use loaded-data fixtures
only in tests; never ship them as inventory. Browser screenshots and production
build checks are separate evidence from unit tests. Do not claim visual acceptance
or deployment readiness when those checks have been deferred.
