---
name: matchplane-ui
description: Build, redesign, or audit MatchPlane's root and subplatform interfaces with a clean chat-first hierarchy, mobile-first usability, and low-noise Anthropic-art and Apple-design guidance. Use when changing web/, a subplatform UI, login/admin flows, theme/locale controls, or interaction tests.
---

# MatchPlane UI

Treat the root shell and every mounted subplatform as the same product surface. The root owns
navigation, identity, consent, and platform state; a subplatform owns its domain copy, fields,
results, and visual accent through the manifest. Never hard-code a vehicle catalogue into the
root shell.

## Workflow

1. Inspect the current route, role, manifest, locale, theme, and authenticated state before
   changing layout or copy. Reuse existing generic components and API helpers.
2. Read `PRODUCT.md`, `docs/subplatform-contract.md`, and the relevant component tests. For visual
   work, also use the `impeccable` skill; use `anthropic-art` for requested editorial/illustration
   assets and `apple-design` for material, motion, and responsive shape decisions.
3. Keep one clear primary action. The chat input is the primary entry on public pages; login,
   registration, consent, payment, and admin actions must remain explicit and genuinely wired.
4. Keep visible chrome quiet: no decorative security badges, technical digests, fake confidence
   percentages, or placeholder buttons in buyer/seller views. Move diagnostics and capability
   details into administrator or debug surfaces.
5. Use the same login/register surface for humans. Preserve pending chat text through auth and
   resume it only after a valid Better Auth session. Do not add a separate child credential store.
6. Verify keyboard focus, Escape/outside-click dismissal, loading/error/empty states, reduced
   motion, dark/light theme, Chinese/English copy, and 320px–1440px layouts. A control that only
   changes local state while claiming a server action succeeded is a defect.
7. Run the smallest relevant tests, then `just check` before handoff. Do not create screenshots or
   caches in `/tmp`; use an explicit ignored output directory and report its size.

## Interaction rules

- Prefer stable headings and subtle entrance transitions over looping typewriter text.
- Keep headings readable on narrow screens; allow natural wrapping rather than clipping one-line
  marketing copy.
- Put account, language, and theme controls in the account/preferences area, aligned to the right;
  hide role-specific admin links from public navigation and reveal them only when authorized.
- Make result cards actionable only when the backing API and consent policy are available. Never
  expose phone/WeChat values from a listing or from an Agent result.
- Pass `theme` and `locale` through the plugin context and let a child package translate its own
  copy. Root code must not invent child-domain fields.

See [references/review-checklist.md](references/review-checklist.md) for the compact acceptance
checklist used in code review and browser smoke tests.
