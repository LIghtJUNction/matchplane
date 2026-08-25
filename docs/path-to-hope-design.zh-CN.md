# MatchPlane × Path-to-Hope visual system

Reference: https://www.anthropic.com/path-to-hope  
Intent: editorial publication quality on a product-first marketplace — not a dashboard, not purple SaaS, not terracotta-cream AI cliché.

## Principles (from Path-to-Hope)

1. **Paper + ink** — page reads like a print essay: warm off-white canvas, near-black ink, almost no chrome.
2. **Dual type** — serif carries voice (display + key body); sans handles UI chrome/nav/labels.
3. **Band rhythm** — alternate light canvas sections with full-bleed near-black utility bands for pacing.
4. **Flat elevation** — hairline borders and tonal steps; shadows rare.
5. **One job per section** — hero = brand + one line + one CTA group + products as the visual plane.
6. **Motion as presence** — 2–3 soft springs (fade/slide), never noise.

## Tokens (MatchPlane)

| Token | Value | Role |
| --- | --- | --- |
| `--hope-canvas` | `#faf9f5` | Page paper |
| `--hope-surface` | `#f0eee6` | Recessed / grouped |
| `--hope-elevated` | `#ffffff` | Rare lift (forms) |
| `--hope-ink` | `#141413` | Text + filled CTA |
| `--hope-muted` | `#5e5d59` | Secondary text |
| `--hope-faint` | `#b0aea5` | Meta |
| `--hope-line` | `#14141322` | Hairline |
| `--hope-inverse` | `#141413` | Dark band fill |
| `--hope-inverse-ink` | `#faf9f5` | Text on dark |
| `--hope-price` | `#141413` | Price = ink (no terracotta shout) |
| `--hope-sage` | `#dfe8e4` | Soft status wash only |

Fonts (Google / system fallbacks approximating Anthropic Sans+Serif):

- `--font-serif`: `"Source Serif 4", "Noto Serif SC", Georgia, serif`
- `--font-sans`: `"Instrument Sans", "Noto Sans SC", ui-sans-serif, system-ui`
- `--font-mono`: `"IBM Plex Mono", ui-monospace, monospace`

## Buyer surfaces to restyle

1. Tokens in `retail-ui.css` + font link in `layout.tsx`
2. Shared chrome: PlatformHeader, PlatformFooter, Brand
3. MarketplaceHome hero + listing grid
4. StorefrontView
5. LoginScreen
6. MatchChat / FloatingMarketplaceClerk (preserve test class names)

## Preserve for tests

`.root-marketplace-page`, `.is-clerk-open`, `.floating-clerk-rnd`, `.root-storefront-page`, `.home-chat`, `.match-chat-message`, `.chat-typing-indicator`, `.conversation-history-dialog`

## Out of scope this pass

Admin/merchant dense panels (keep readable; inherit tokens only).
