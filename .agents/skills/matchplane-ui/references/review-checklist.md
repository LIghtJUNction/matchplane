# MatchPlane UI review checklist

## Public buyer/seller surface

- [ ] Root `/` explains the generic matching purpose and keeps the chat input visible.
- [ ] A child path reuses the chat contract but renders only that package's schema/copy.
- [ ] Buyer and supply entry points are discoverable without exposing admin navigation.
- [ ] Empty, loading, degraded, and unauthorized states explain the next action in plain language.
- [ ] Results show canonical references and reasons, not private identities or contact values.

## Auth and consent

- [ ] One login/register form accepts the configured email/phone/fallback methods.
- [ ] Passkey, OTP, magic link, national identity, and social buttons appear only when configured.
- [ ] Pending chat input survives the auth redirect and is submitted once after session creation.
- [ ] Contact exchange is a separate, explicit two-party consent step; offline contact is never
      reported as sent when the real API is disabled.

## Responsive and interaction quality

- [ ] 320px, 390px, tablet, and desktop layouts have no clipped headings or horizontal overflow.
- [ ] All buttons and links have a real handler or are disabled with an honest explanation.
- [ ] Menus close on selection, outside pointer, and Escape; focus remains visible and logical.
- [ ] Light/dark and zh/en preferences affect the shell and child iframe context.
- [ ] Motion respects `prefers-reduced-motion`; no looping animation carries product meaning.

## Admin and diagnostics

- [ ] Root/subplatform admin links are authorization-gated and not part of public chrome.
- [ ] Technical manifest, digest, MCP, and builder details stay in admin/debug views.
- [ ] Forms show server errors and do not display success until the mutation is confirmed.
