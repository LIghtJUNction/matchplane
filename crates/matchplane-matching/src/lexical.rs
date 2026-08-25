use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{
    MATCHING_ADVISORY_NOTICE, MatchingError, TokenPolicy,
    token::{bounded_join, bounded_prefixed, truncate_chars},
    tokenize,
};

/// Public metadata used by [`rank_lexical_candidates`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LexicalCandidate {
    /// Public candidate name.
    pub display_name: String,
    /// Public candidate description.
    pub description: String,
    /// Whether domain policy permits this candidate to participate.
    pub eligible: bool,
    /// Caller-computed intent boost. Non-finite values are treated as zero.
    pub intent_boost: f64,
    /// Caller-computed, public intent explanations.
    pub intent_reasons: Vec<String>,
}

/// Bounds for storefront-style lexical ranking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LexicalRankPolicy {
    max_input_candidates: usize,
    max_results: usize,
    token_policy: TokenPolicy,
    max_explanations: usize,
    max_explanation_characters: usize,
}

impl LexicalRankPolicy {
    /// Creates a policy with explicit input-computation, output, token, and explanation bounds.
    #[must_use]
    pub const fn new(
        max_input_candidates: usize,
        max_results: usize,
        token_policy: TokenPolicy,
        max_explanations: usize,
        max_explanation_characters: usize,
    ) -> Self {
        Self {
            max_input_candidates,
            max_results,
            token_policy,
            max_explanations,
            max_explanation_characters,
        }
    }

    /// Maximum candidates inspected and represented in ranking state.
    #[must_use]
    pub const fn max_input_candidates(self) -> usize {
        self.max_input_candidates
    }

    /// Maximum ranked candidates returned.
    #[must_use]
    pub const fn max_results(self) -> usize {
        self.max_results
    }
}

impl Default for LexicalRankPolicy {
    fn default() -> Self {
        Self::new(2_000, 2_000, TokenPolicy::router(512), 8, 240)
    }
}

/// One eligible candidate ranked without changing or granting caller authority.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RankedLexicalCandidate {
    /// Index in the caller's original candidate slice.
    pub candidate_index: usize,
    /// Score in the inclusive `0.0..=0.99` range.
    pub score: f64,
    /// Number of unique query tokens found in public candidate metadata.
    pub overlap_count: usize,
    /// Bounded matching labels in query-token order.
    pub overlap_labels: Vec<String>,
    /// Bounded public explanation fragments.
    pub explanations: Vec<String>,
    /// Reminder that ranking grants no authority or consent.
    pub advisory: &'static str,
}

/// Ranks eligible candidates by overlap, score, then original row order under explicit budgets.
///
/// Inputs over `max_input_candidates` return an error before ranking. Candidate name and
/// description are copied only into a token-policy-bounded temporary buffer, and at most
/// `max_results` are returned. Query-token first-occurrence order is retained in `overlap_labels`.
///
/// # Errors
///
/// Returns [`MatchingError::TooManyCandidates`] instead of silently truncating input.
pub fn rank_lexical_candidates(
    candidates: &[LexicalCandidate],
    narrative: &str,
    policy: LexicalRankPolicy,
) -> Result<Vec<RankedLexicalCandidate>, MatchingError> {
    if candidates.len() > policy.max_input_candidates {
        return Err(MatchingError::TooManyCandidates {
            actual: candidates.len(),
            maximum: policy.max_input_candidates,
        });
    }
    let query_tokens = tokenize(narrative, policy.token_policy);
    let mut ranked = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.eligible)
        .map(|(candidate_index, candidate)| {
            let haystack = bounded_join(
                [
                    candidate.display_name.as_str(),
                    candidate.description.as_str(),
                ],
                '\n',
                policy.token_policy.max_characters(),
            );
            let haystack_tokens: HashSet<String> = tokenize(&haystack, policy.token_policy)
                .into_iter()
                .collect();
            let overlaps: Vec<&String> = query_tokens
                .iter()
                .filter(|token| haystack_tokens.contains(*token))
                .collect();
            let lexical_score = if query_tokens.is_empty() {
                0.35
            } else {
                0.35 + overlaps.len() as f64 / query_tokens.len().max(4) as f64
            };
            let boost = if candidate.intent_boost.is_finite() {
                candidate.intent_boost
            } else {
                0.0
            };
            let mut explanations: Vec<String> = candidate
                .intent_reasons
                .iter()
                .take(policy.max_explanations)
                .map(|reason| truncate_chars(reason, policy.max_explanation_characters))
                .collect();
            for token in &overlaps {
                if explanations.len() >= policy.max_explanations {
                    break;
                }
                explanations.push(bounded_prefixed(
                    "lexical overlap: ",
                    token,
                    policy.max_explanation_characters,
                ));
            }
            RankedLexicalCandidate {
                candidate_index,
                score: (lexical_score + boost).clamp(0.0, 0.99),
                overlap_count: overlaps.len(),
                overlap_labels: overlaps
                    .into_iter()
                    .take(policy.max_explanations)
                    .map(|token| truncate_chars(token, policy.max_explanation_characters))
                    .collect(),
                explanations,
                advisory: MATCHING_ADVISORY_NOTICE,
            }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .overlap_count
            .cmp(&left.overlap_count)
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| left.candidate_index.cmp(&right.candidate_index))
    });
    ranked.truncate(policy.max_results);
    Ok(ranked)
}
