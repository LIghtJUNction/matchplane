# matchplane-matching

`matchplane-matching` is a small provider-neutral kernel for deterministic and AI-assisted
candidate matching. It owns no credentials and performs no network, database, authorization,
contact-consent, or payment work. Bring any model provider—or no model at all.

> **Authority boundary:** every result is a recommendation only. A result grants no authorization,
> contact consent, payment authority, contractual acceptance, or other right. Callers must enforce
> those policies outside this crate.

The separate `matchplane-engine` crate remains a price-time order-book engine. This crate does not
replace or depend on it.

## What is included

- Stable candidate windows with separate default computation/output limits of 4,096/32; oversized
  input returns an error before ranking allocation.
- Deterministic multilingual token and structured-attribute scoring under explicit field, byte,
  node, depth, token, candidate, and explanation budgets.
- A model-free fallback whose candidate count and exact identifiers are validated before output;
  confidence is always `None` and the result is marked degraded.
- Strict provider selection parsing, allowlisting, stable deduplication, confidence normalization,
  and bounded observable rejection of unknown candidates.
- Detailed and compact provider payload structures that are serialized whole; JSON strings are
  never cut after serialization.
- Truthful storefront lexical ranking with eligibility and bounded caller-supplied intent evidence.

## BYO-model example

The crate prepares a bounded prompt and validates the response. Sending the JSON to a provider is
intentionally the application's responsibility.

```rust
use matchplane_matching::{
    CandidateWindowPolicy, DecisionPolicy, ProviderPayloadPolicy, RouteCandidate,
    build_provider_payload, normalize_provider_decision, parse_provider_decision,
    select_candidate_window,
};
use serde_json::json;

# fn main() -> Result<(), Box<dyn std::error::Error>> {
let candidates = vec![
    RouteCandidate {
        slug: "bikes".into(),
        path: "/bikes".into(),
        display_name: "城市自行车".into(),
        description: "通勤与载货".into(),
        capabilities: vec!["catalog.search".into()],
        agent_stages: vec!["retrieval".into()],
        agent_skills: vec!["bike-fit".into()],
    },
    RouteCandidate {
        slug: "books".into(),
        path: "/books".into(),
        display_name: "书店".into(),
        description: "技术图书".into(),
        capabilities: vec!["catalog.search".into()],
        agent_stages: vec!["retrieval".into()],
        agent_skills: vec!["book-search".into()],
    },
];
let window = select_candidate_window(
    &candidates,
    "需要一辆通勤自行车",
    CandidateWindowPolicy::default(),
)?;
let provider_candidates = window.into_iter().cloned().collect::<Vec<_>>();
let payload = build_provider_payload(
    "/",
    "需要一辆通勤自行车",
    &provider_candidates,
    ProviderPayloadPolicy::default(),
)?;

// Send `payload.json` through your own model SDK. The SDK response is untrusted input.
let provider_json = json!({
    "selectedSlugs": ["bikes", "invented", "bikes"],
    "rationale": "  bicycles match the request  ",
    "confidence": 1.4
});
let raw = parse_provider_decision(&provider_json, DecisionPolicy::default())?;
let allowlist = provider_candidates
    .iter()
    .map(|candidate| candidate.slug.as_str())
    .collect::<Vec<_>>();
let decision = normalize_provider_decision(raw, &allowlist, DecisionPolicy::default())?;

assert_eq!(decision.selected_slugs, ["bikes"]);
assert_eq!(decision.confidence, Some(1.0));
assert_eq!(decision.rejected.len(), 2); // unknown + duplicate, both observable
assert!(payload.serialized_bytes <= 24_000);
assert!(decision.advisory.contains("no authorization"));
# Ok(())
# }
```

If the provider is absent, times out, or returns malformed data, use
`deterministic_fallback`. It never presents lexical overlap as AI confidence:

```rust
use matchplane_matching::{FallbackPolicy, deterministic_fallback};
# use matchplane_matching::RouteCandidate;
# fn main() -> Result<(), Box<dyn std::error::Error>> {
# let candidates: Vec<RouteCandidate> = Vec::new();
let decision = deterministic_fallback(
    &candidates,
    "通勤自行车",
    Some("The configured model was unavailable."),
    FallbackPolicy::default(),
)?;
assert_eq!(decision.confidence, None);
assert!(decision.degraded);
# Ok(())
# }
```

## Determinism and Unicode

Token limits and output order are explicit policy rather than hidden globals. Router/storefront
policy emits at most 512 unique tokens in first-occurrence order. MatchPlane storage deliberately
passes `TokenPolicy::storage_compatible(256)`, which preserves its historical raw-token limit and
sorted order.

Rust truncation counts Unicode scalar values and additionally enforces escaped UTF-8 content budgets
for compact JSON. JavaScript `slice` counts UTF-16 code units, so exact cut positions can differ for
non-BMP emoji. This crate never creates half a surrogate or invalid UTF-8. The stable hash likewise
iterates scalar values, matching JavaScript `for...of`/`codePointAt` intent rather than UTF-16 unit
indexing.

## Candidate identity and provider boundary

Candidate selection identifiers use one shared exact grammar:
`[A-Za-z0-9._:-]{1,120}`. `validate_candidate_id`, fallback, provider normalization, and payload
construction all enforce it. Identity values are never truncated. Deterministic fallback returns an
error for an invalid candidate; provider normalization excludes a typed invalid selection and emits
bounded `InvalidCandidateId` rejection evidence.

Provider output is not trusted. `selectedSlugs` must be a bounded array of strings. Unknown slugs
are rejected, duplicates are removed without reordering, and bounded rejection evidence is returned
to the caller. Finite confidence is clamped to `0..=1`; non-finite confidence becomes `None`.
Rationales and rejection previews are inspected and copied only to their configured bounds.

Payload construction caps candidate count, narrative, display name, description, capability,
agent-stage, and agent-skill fields. If detailed serialization exceeds 24,000 bytes, the crate builds
a new compact object and serializes it. It never truncates serialized JSON.

Structured scoring does not serialize the complete supplied JSON. `StructuredDataBudget` limits the
number of demand attributes and aggregate key/value bytes, nodes, and nesting depth inspected.
Supply fields are walked directly into a token-policy-sized buffer.

Storefront lexical ranking makes no match claim for an empty query or for zero token overlap: its
lexical component is `0`. The existing `0.35 + overlap_count / max(query_token_count, 4)` formula
applies only when `overlap_count > 0`. A zero-overlap candidate is returned only when the caller
supplies a positive finite intent boost or a non-empty bounded intent reason. Its score is then the
bounded structured contribution alone. Caller intent reasons are trimmed, empty values are dropped,
and first occurrences are retained; generated lexical reasons remain explicitly labeled. Scores are
clamped to `0.99`, and ranking never invents structured intent evidence.

Every public candidate-ranking policy separates `max_input_candidates` from `max_results`.
`select_candidate_window`, `rank_fallback_candidates`, and `rank_lexical_candidates` return
`TooManyCandidates` before ranking when the input budget is exceeded; they never silently discard
excess input. Accepted lexical metadata is copied only into bounded temporary buffers, and output is
explicitly capped by `max_results`. Default limits are 4,096/32 for provider windows, 32/4 for
fallback, and 2,000/2,000 for storefront lexical ranking.

## MSRV and license

The verified minimum Rust version for this release is **1.97**. The crate uses Rust 2024 and is
licensed under MIT.
