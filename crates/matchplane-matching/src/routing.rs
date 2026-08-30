use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{
    DecisionSource, MATCHING_ADVISORY_NOTICE, MatchingError, RouteDecision, TokenPolicy,
    token::{bounded_join, bounded_trim},
    tokenize, validate_candidate_id,
};

const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

/// Provider-neutral public metadata for one routing candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCandidate {
    /// Provider selection key.
    pub slug: String,
    /// Stable public route path.
    pub path: String,
    /// Public display name.
    pub display_name: String,
    /// Public description.
    pub description: String,
    /// Public retrieval or business capabilities.
    pub capabilities: Vec<String>,
    /// Public agent lifecycle stages.
    pub agent_stages: Vec<String>,
    /// Public agent skills.
    pub agent_skills: Vec<String>,
}

/// Policy for selecting a fair bounded provider candidate window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateWindowPolicy {
    max_input_candidates: usize,
    max_results: usize,
    token_policy: TokenPolicy,
}

impl CandidateWindowPolicy {
    /// Creates a window policy with explicit input-computation, output, and token limits.
    #[must_use]
    pub const fn new(
        max_input_candidates: usize,
        max_results: usize,
        token_policy: TokenPolicy,
    ) -> Self {
        Self {
            max_input_candidates,
            max_results,
            token_policy,
        }
    }

    /// Maximum candidates inspected and represented in ranking state.
    #[must_use]
    pub const fn max_input_candidates(self) -> usize {
        self.max_input_candidates
    }

    /// Maximum candidates returned.
    #[must_use]
    pub const fn max_results(self) -> usize {
        self.max_results
    }
}

impl Default for CandidateWindowPolicy {
    fn default() -> Self {
        Self::new(4_096, 32, TokenPolicy::router(512))
    }
}

/// Policy for model-free deterministic fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FallbackPolicy {
    max_input_candidates: usize,
    max_results: usize,
    max_rationale_characters: usize,
    token_policy: TokenPolicy,
}

impl FallbackPolicy {
    /// Creates a fallback policy with explicit output and token limits.
    #[must_use]
    pub const fn new(
        max_input_candidates: usize,
        max_results: usize,
        max_rationale_characters: usize,
        token_policy: TokenPolicy,
    ) -> Self {
        Self {
            max_input_candidates,
            max_results,
            max_rationale_characters,
            token_policy,
        }
    }

    /// Maximum candidates inspected and represented in fallback ranking state.
    #[must_use]
    pub const fn max_input_candidates(self) -> usize {
        self.max_input_candidates
    }

    /// Maximum fallback candidates returned or selected.
    #[must_use]
    pub const fn max_results(self) -> usize {
        self.max_results
    }
}

impl Default for FallbackPolicy {
    fn default() -> Self {
        Self::new(32, 4, 1_000, TokenPolicy::router(512))
    }
}

/// Selects a stable, computation-bounded provider window without starving later candidates.
///
/// Inputs over `max_input_candidates` return an error rather than being silently truncated.
/// Windows already within `max_results` retain registration order. Larger accepted sets are ordered
/// by unique metadata-token overlap, then a stable FNV-1a-like hash of
/// `narrative + NUL + path`, then original index.
///
/// # Errors
///
/// Returns [`MatchingError::TooManyCandidates`] before allocating ranking state.
pub fn select_candidate_window<'a>(
    candidates: &'a [RouteCandidate],
    narrative: &str,
    policy: CandidateWindowPolicy,
) -> Result<Vec<&'a RouteCandidate>, MatchingError> {
    if candidates.len() > policy.max_input_candidates {
        return Err(MatchingError::TooManyCandidates {
            actual: candidates.len(),
            maximum: policy.max_input_candidates,
        });
    }
    if candidates.len() <= policy.max_results {
        return Ok(candidates.iter().collect());
    }
    let intent_tokens: HashSet<String> = tokenize(narrative, policy.token_policy)
        .into_iter()
        .collect();
    let mut ranked = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let metadata_tokens = tokenize(
                &candidate_metadata(candidate, policy.token_policy),
                policy.token_policy,
            );
            let overlap = metadata_tokens
                .iter()
                .filter(|token| intent_tokens.contains(*token))
                .count();
            WindowEntry {
                candidate,
                index,
                overlap,
                tie: stable_candidate_hash(
                    narrative,
                    &candidate.path,
                    policy.token_policy.max_characters(),
                ),
            }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .overlap
            .cmp(&left.overlap)
            .then_with(|| left.tie.cmp(&right.tie))
            .then_with(|| left.index.cmp(&right.index))
    });
    Ok(ranked
        .into_iter()
        .take(policy.max_results)
        .map(|entry| entry.candidate)
        .collect())
}

/// Ranks a validated, bounded fallback window by token overlap and registration order only.
///
/// Empty narratives and all-zero overlap preserve registration order. Identity values are never
/// truncated.
///
/// # Errors
///
/// Returns [`MatchingError::TooManyCandidates`] or [`MatchingError::InvalidCandidateId`].
pub fn rank_fallback_candidates<'a>(
    candidates: &'a [RouteCandidate],
    narrative: &str,
    policy: FallbackPolicy,
) -> Result<Vec<&'a RouteCandidate>, MatchingError> {
    validate_fallback_candidates(candidates, policy)?;
    let intent_tokens = tokenize(narrative, policy.token_policy);
    let mut ranked = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let metadata: HashSet<String> = tokenize(
                &candidate_metadata(candidate, policy.token_policy),
                policy.token_policy,
            )
            .into_iter()
            .collect();
            let overlap = intent_tokens
                .iter()
                .filter(|token| metadata.contains(*token))
                .count();
            (candidate, index, overlap)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.1.cmp(&right.1)));
    Ok(ranked
        .into_iter()
        .take(policy.max_results)
        .map(|(candidate, _, _)| candidate)
        .collect())
}

/// Returns a bounded deterministic fallback decision with `confidence = None`.
///
/// Every selected slug must satisfy the shared exact candidate-ID grammar. Identity values are
/// never truncated. `context` is copied only up to the configured rationale boundary.
///
/// # Errors
///
/// Returns [`MatchingError::TooManyCandidates`] or [`MatchingError::InvalidCandidateId`] before
/// producing a decision.
pub fn deterministic_fallback(
    candidates: &[RouteCandidate],
    narrative: &str,
    context: Option<&str>,
    policy: FallbackPolicy,
) -> Result<RouteDecision, MatchingError> {
    let selected_slugs = rank_fallback_candidates(candidates, narrative, policy)?
        .into_iter()
        .map(|candidate| candidate.slug.clone())
        .collect();
    let prefix = "Deterministic metadata-overlap fallback; no model confidence is claimed.";
    let bounded_context = context
        .map(|value| bounded_trim(value, policy.max_rationale_characters))
        .filter(|value| !value.is_empty());
    let rationale = bounded_join(
        std::iter::once(prefix).chain(bounded_context.as_deref()),
        ' ',
        policy.max_rationale_characters,
    );
    Ok(RouteDecision {
        selected_slugs,
        source: DecisionSource::DeterministicFallback,
        rationale,
        confidence: None,
        degraded: true,
        rejected: Vec::new(),
        rejection_overflow: 0,
        advisory: MATCHING_ADVISORY_NOTICE,
    })
}

/// Computes the stable non-cryptographic hash used only for deterministic tie-breaking.
///
/// Hashing iterates Unicode scalar values. Unlike JavaScript UTF-16 indexing, a non-BMP emoji is
/// processed as one scalar and is never split into surrogate halves.
#[must_use]
pub fn stable_hash(value: &str) -> u32 {
    update_hash(FNV_OFFSET_BASIS, value.chars())
}

struct WindowEntry<'a> {
    candidate: &'a RouteCandidate,
    index: usize,
    overlap: usize,
    tie: u32,
}

fn validate_fallback_candidates(
    candidates: &[RouteCandidate],
    policy: FallbackPolicy,
) -> Result<(), MatchingError> {
    if candidates.len() > policy.max_input_candidates {
        return Err(MatchingError::TooManyCandidates {
            actual: candidates.len(),
            maximum: policy.max_input_candidates,
        });
    }
    for (index, candidate) in candidates.iter().enumerate() {
        validate_candidate_id(&candidate.slug)
            .map_err(|reason| MatchingError::InvalidCandidateId { index, reason })?;
    }
    Ok(())
}

fn stable_candidate_hash(narrative: &str, path: &str, maximum_characters: usize) -> u32 {
    let hash = update_hash(FNV_OFFSET_BASIS, narrative.chars().take(maximum_characters));
    let hash = update_hash(hash, ['\0']);
    update_hash(hash, path.chars().take(maximum_characters))
}

fn update_hash<I>(mut hash: u32, characters: I) -> u32
where
    I: IntoIterator<Item = char>,
{
    for character in characters {
        hash ^= character as u32;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn candidate_metadata(candidate: &RouteCandidate, policy: TokenPolicy) -> String {
    bounded_join(
        std::iter::once(candidate.slug.as_str())
            .chain(std::iter::once(candidate.display_name.as_str()))
            .chain(std::iter::once(candidate.description.as_str()))
            .chain(candidate.capabilities.iter().map(String::as_str))
            .chain(candidate.agent_skills.iter().map(String::as_str)),
        ' ',
        policy.max_characters(),
    )
}
