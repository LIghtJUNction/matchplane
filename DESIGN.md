---
name: "matchplane"
colors:
  background: "--background"
  surface: "--surface"
  text: "--foreground"
  primary: "--primary"
---

# Design System: matchplane

## Visual Theme & Atmosphere

- [observed] Existing first-party theme, shared component, and page sources define the current visual baseline.
- [inferred confidence=medium] Preserve the observed token vocabulary, density, and component conventions when adding new surfaces.

## Color Palette & Roles

- [observed] `--surface: rgba(250, 249, 245, 0.86)`
- [observed] `--surface: rgba(35, 35, 33, 0.9)`
- [observed] `#141413`
- [observed] `#353532`
- [observed] `#6f706a`
- [observed] `#faf9f5`
- [observed] `#f0eee6`
- [observed] `#e8e6dc`
- [confirmed] Use warm ivory, ink, cactus, olive, and clay for product UI; avoid generic “tech blue.”
- [confirmed] Keyboard focus uses burnt clay `--focus: #9f4f35` (light) / `#f1a07d` (dark), never blue as a default accent.

## Typography Rules

- [observed] `"Avenir Next", "SF Pro Display", "SF Pro Text", ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
- [observed] `"Avenir Next", "SF Pro Text", ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
- [observed] `ui-monospace, SFMono-Regular, Menlo, monospace`
- [observed] `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif`
- [inferred confidence=medium] Reuse the existing font stack and derive hierarchy from shared components before introducing new sizes.

## Component Stylings

- [observed] `subplatforms/auto/src/components/BuyerDashboard.tsx`
- [observed] `subplatforms/auto/src/components/Overlays.tsx`
- [observed] `subplatforms/auto/src/components/PlatformDashboard.tsx`
- [observed] `subplatforms/auto/src/components/Primitives.tsx`
- [observed] `subplatforms/auto/src/components/SellerDashboard.tsx`
- [observed] `web/src/admin/components/DataTable.tsx`
- [observed] `web/src/admin/components/StatusCard.tsx`
- [observed] `web/src/components/BuyerDashboard.tsx`
- [inferred confidence=medium] Prefer existing primitives and variants over page-local replacements.

## Layout Principles

- [inferred confidence=low] No named spacing tokens were detected; confirm the base spacing rhythm.
- [observed] Representative page: `web/app/page.tsx`
- [observed] Representative page: `web/app/[...platformPath]/page.tsx`
- [observed] Representative page: `web/app/about/page.tsx`
- [observed] Representative page: `web/app/admin/page.tsx`
- [observed] Representative page: `web/app/admin/register/page.tsx`
- [observed] Representative page: `web/app/login/page.tsx`
- [inferred confidence=medium] Match the density and alignment rhythm of representative pages.
- [confirmed] The root marketplace is chat-first: a fixed desktop navigation rail, one centered empty-state composer, and real catalog content below the first viewport; collapse the rail below 56rem.
- [confirmed] Active conversations replace the empty-state heading and shortcuts with a bounded message log and bottom composer; loading and retry feedback stay inside that conversation flow.
- [confirmed] Settings, account, and shopping-memory surfaces use a compact split shell on desktop—quiet left navigation, one right content pane, hairline separators, and no nested card grid. On mobile, navigation becomes a horizontal strip.

## Motion & Interaction

- [inferred confidence=low] No motion token was detected; keep transitions restrained until interaction evidence is available.
- [inferred confidence=medium] Preserve visible hover, focus, pressed, loading, and reduced-motion behavior from existing primitives.

## Accessibility

- [inferred confidence=medium] Preserve semantic controls, keyboard focus visibility, and non-color state cues present in existing primitives.
- [confirmed] Dialogs restore focus, close with Escape/outside click, expose named navigation and controls, and keep every action reachable at 320px.
- [inferred confidence=low] Contrast, touch targets, text scaling, and reduced-motion behavior require runtime verification.

## Source Evidence & Confidence

- [observed] path: `subplatforms/auto/src/plugin-entry.tsx`
  sha256: `721b034face91ff619c073ff156a484c1ec243bbe3c52cc739e9c28cca9eb982`
  confidence: high
- [observed] path: `subplatforms/auto/src/styles.css`
  sha256: `150c9d35bafa884fd362e588e4d703eabf5f2534b05e47c7fe58f3469fb4121c`
  confidence: high
- [observed] path: `subplatforms/auto/src/components/BuyerDashboard.tsx`
  sha256: `93e4da5d0aba904f7a0bb050eec00f464e7363a19d247eb2971675298768d30f`
  confidence: high
- [observed] path: `subplatforms/auto/src/components/Overlays.tsx`
  sha256: `046015b4812f2f3f27f994bcb77051482423e96b6c47fb8d6b5220a04cbebb96`
  confidence: high
- [observed] path: `subplatforms/auto/src/components/PlatformDashboard.tsx`
  sha256: `ebb59bfcad322c5c13f38aaf8be1d79e8fc689240c5834072aa7831711a28900`
  confidence: high
- [observed] path: `subplatforms/auto/src/components/Primitives.tsx`
  sha256: `708371b9502bce634525fbf3c0d6399405301078947ea33e689ddc9c09e0acd0`
  confidence: high
- [observed] path: `subplatforms/auto/src/components/SellerDashboard.tsx`
  sha256: `de33135df1bd05a1c09d9193bcd6c439e1d6dacefa5ff92bdb5f30ae9af5e39b`
  confidence: high
- [observed] path: `web/app/layout.tsx`
  sha256: `817c90205a92f3e9090607e25ae2cd0a109958f935e88b9f500200b5473693c8`
  confidence: high
- [observed] path: `web/app/page.tsx`
  sha256: `03c7ab0c0e0ac56c0cb783d16a4c7592599823ebdfeaa132bb64c6bf77cb5177`
  confidence: high
- [observed] path: `web/app/[...platformPath]/page.tsx`
  sha256: `ce3a1147f3fff7aa522a18a4cf5b35c00a6131bc45e27ddced90845d8325f510`
  confidence: high
- [observed] path: `web/app/about/page.tsx`
  sha256: `eba8be038b1599d785c6d9591c6b672bda7fc77b0a3ba6c0b3152c14c7373cfe`
  confidence: high
- [observed] path: `web/app/admin/page.tsx`
  sha256: `2d360b01fb9e4a6e9504f810d0213f9f95653ab2951a6d70316b6b2c7fc9d6b2`
  confidence: high
- [observed] path: `web/app/admin/register/page.tsx`
  sha256: `2797b3fa847656f9ea1c493922845028f35a9a6bc8dd7fd097245005b26857d3`
  confidence: high
- [observed] path: `web/app/login/page.tsx`
  sha256: `055488732e9903e02699298766ee94aa85f2fa558477516f7dc2808f87045df1`
  confidence: high
- [observed] path: `web/app/oauth/consent/page.tsx`
  sha256: `a995481dc4caed00e08fae0f55a0313fcd1df404b8e03687b8ca3326851c78b1`
  confidence: high
- [observed] path: `web/app/privacy/page.tsx`
  sha256: `f4b822ca7e4ed6321fa7d4c292797706978393c83c9f4ea274074f0428693cfd`
  confidence: high
- [observed] path: `web/app/register/page.tsx`
  sha256: `13488c6d13751cddddc7e522685739c0d936641560f1b25972a84e245d2d7c61`
  confidence: high
- [observed] path: `web/app/terms/page.tsx`
  sha256: `2de759eb431f508f50dd2972dfa98c3d5dfb05e41d894b3792ee45a4ae1d3278`
  confidence: high
- [observed] path: `web/src/App.test.tsx`
  sha256: `c22989a2f7e37e7ade7440d391ddff2347badac48c40367a728e115ecd861f33`
  confidence: high
- [observed] path: `web/src/App.tsx`
  sha256: `0e03f0fd4cbfc68ab42ec31d9f527c1daed9a0a24e85f65a32565e3e876e1409`
  confidence: high
- [observed] path: `web/src/styles.css`
  sha256: `c7a66923feed3c883438c10003d6bb1d2079ed1bbfa57fa9353a9dd05bac2af0`
  confidence: high
- [observed] path: `web/src/admin/components/DataTable.tsx`
  sha256: `d43c94b7e734756cccc6d74d77a66fbb0e8d0fa6afefe761192b0fc242ab349e`
  confidence: high
- [observed] path: `web/src/admin/components/StatusCard.tsx`
  sha256: `16b592bca28b61c92b2bf6c5dce4019bc5dd6e4b6f59d727eb0539e766e6e9c4`
  confidence: high
- [observed] path: `web/src/admin/pages/AIModelsPage.tsx`
  sha256: `64444650780200f413af5de95ec405849fe99ba30477e204f97d0d2414b05611`
  confidence: high
- [observed] path: `web/src/admin/pages/MerchantsPage.tsx`
  sha256: `92c32679c5da26d43d806672c3fc0eb7cc90fa48e6c47b492596ae22bb9afca0`
  confidence: high
- [observed] path: `web/src/admin/pages/NotificationsPage.tsx`
  sha256: `3af39079b0a4face270bf70fa50f94c650906074e6f7d0028b2a85ee5e2bd68a`
  confidence: high
- [observed] path: `web/src/admin/pages/OAuthProvidersPage.tsx`
  sha256: `30619a8b6d2101e474a83d691b9199f2292cec3124471b5d86a6aa3ec1fc2dc5`
  confidence: high
- [observed] path: `web/src/admin/pages/SecurityPage.tsx`
  sha256: `b23495b076d52d482153ec11039474928d0de2be46c5a01e5769d954a77c32f9`
  confidence: high
- [observed] path: `web/src/admin/pages/UsersPage.tsx`
  sha256: `13c5bef15b8215270627a920e5a0a052a189da8a4c513ffc7de6aab04b0afcab`
  confidence: high
- [observed] path: `web/src/auth/AuthLayout.tsx`
  sha256: `1d2de4bc791877e3bf01cf6720370fdee44a26a5ed5ab9b657efc776d3080538`
  confidence: high
- [observed] path: `web/src/components/BuyerDashboard.tsx`
  sha256: `bf80e9b5e2653ad1e4e29e2ab6204682f06821db46c1bf6f9f08342bc7ec6fcd`
  confidence: high
- [observed] path: `web/src/components/ChangePasswordPanel.test.tsx`
  sha256: `01be40b6a28952b882a7179f9ae028da93321c2db21040928f1569f208af23e7`
  confidence: high

## Known Gaps & Exceptions

- [inferred confidence=medium] Semantic intent inferred from implementation must be reviewed before this draft becomes project authority.
- [observed] Shape token `--radius-small: 0.9rem`
- [observed] Shape token `--radius-medium: 1.35rem`
- [observed] Shape token `--radius-large: 2rem`
- [observed] Shape token `--radius-hero: 2.6rem`
- [observed] Shape token `--background: var(--ivory)`
- [observed] Shape token `--background-subtle: var(--paper)`
