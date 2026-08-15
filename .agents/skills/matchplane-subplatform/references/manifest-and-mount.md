# Manifest and mount checklist

- Require `apiVersion: matchplane.subplatform/v1`, `rootApiVersion: v1`, a globally stable `id`,
  a lowercase slug, immutable source/build digests, and only declared scopes.
- Keep `parentOrganizationId` explicit at registration. Better Auth organization membership and
  PostgreSQL's parent foreign key/cycle trigger are the authority.
- Route only `state = active` registrations. For `/a/b`, verify both `/a` and `/a/b`; missing,
  disabled, or stale ancestors fail closed.
- Let each subplatform own retrieval. The root exchanges `matchplane.retrieval/v1` envelopes,
  canonical asset IDs, scores, provider versions, and degraded state—never vectors or credentials.
- A selected child is the only branch eligible for the next Agent decision. Never broadcast to
  siblings, invent slugs, or bypass the step/depth/hop caps.
