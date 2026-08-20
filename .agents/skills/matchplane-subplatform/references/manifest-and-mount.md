# Manifest and mount checklist

- Require `apiVersion: matchplane.subplatform/v1`, `rootApiVersion: v1`, a globally stable `id`,
  a lowercase slug, immutable source/build digests, and only declared scopes.
- Do not accept a caller-selected `parentOrganizationId`. Resolve the canonical marketplace root
  on the server and attach every new store directly to it.
- Route only active public stores. New canonical paths contain one slug, such as `/store-a`.
  Preserve historical multi-segment paths only as compatibility aliases and audit scope tokens.
- Let each subplatform own retrieval. The root exchanges `matchplane.retrieval/v1` envelopes,
  canonical asset IDs, scores, provider versions, and degraded state—never vectors or credentials.
- The mall Agent selects a bounded set of stores from the database whitelist once. Re-read active
  canonical offers before returning them; never invent slugs, expose contacts, or recursively fan
  out through another store.
