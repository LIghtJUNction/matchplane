use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    MATCHING_ADVISORY_NOTICE, MAX_CANDIDATE_ID_CHARACTERS, MatchingError,
    token::{bounded_trim, truncate_chars_observed},
    validate_candidate_id,
};

/// Origin of a normalized recommendation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum DecisionSource {
    /// A caller-owned model provider returned the selection.
    Provider,
    /// No model selection was used; deterministic metadata overlap produced the result.
    DeterministicFallback,
}

/// Why a provider-supplied selection was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum RejectionReason {
    /// The slug was absent from the exact caller-provided allowlist.
    UnknownCandidate,
    /// The slug had already been accepted earlier in the same provider response.
    DuplicateCandidate,
    /// The slug violated the shared exact candidate-ID boundary.
    InvalidCandidateId,
}

/// Bounded, non-secret evidence that a provider selection was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RejectedSelection {
    /// Zero-based position in the provider response.
    pub index: usize,
    /// Bounded preview of the rejected slug.
    pub slug: String,
    /// Whether the preview was shortened at a Unicode scalar boundary.
    pub truncated: bool,
    /// Validation reason.
    pub reason: RejectionReason,
}

/// Raw typed fields returned by a caller-owned provider SDK.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDecisionInput {
    /// Candidate slugs proposed by the provider, in provider order.
    pub selected_slugs: Vec<String>,
    /// Optional provider rationale.
    #[serde(default)]
    pub rationale: Option<String>,
    /// Optional provider confidence. Non-finite values are discarded during normalization.
    #[serde(default)]
    pub confidence: Option<f64>,
}

/// Bounds applied while normalizing a provider decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionPolicy {
    max_allowed_candidates: usize,
    max_selected_entries: usize,
    max_rejections: usize,
    max_rationale_characters: usize,
    max_observed_slug_characters: usize,
}

impl DecisionPolicy {
    /// Creates an explicit provider boundary policy.
    #[must_use]
    pub const fn new(
        max_allowed_candidates: usize,
        max_selected_entries: usize,
        max_rejections: usize,
        max_rationale_characters: usize,
        max_observed_slug_characters: usize,
    ) -> Self {
        Self {
            max_allowed_candidates,
            max_selected_entries,
            max_rejections,
            max_rationale_characters,
            max_observed_slug_characters,
        }
    }
}

impl Default for DecisionPolicy {
    fn default() -> Self {
        Self::new(32, 32, 32, 1_000, MAX_CANDIDATE_ID_CHARACTERS)
    }
}

/// A normalized provider or deterministic fallback recommendation.
///
/// `advisory` is always [`crate::MATCHING_ADVISORY_NOTICE`]. The result does not grant access,
/// contact consent, or payment rights.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    /// Allowlisted candidate slugs, de-duplicated without reordering.
    pub selected_slugs: Vec<String>,
    /// Whether a provider or deterministic fallback produced the recommendation.
    pub source: DecisionSource,
    /// Bounded public rationale.
    pub rationale: String,
    /// Finite provider confidence in `0.0..=1.0`, or `None` for fallback/invalid values.
    pub confidence: Option<f64>,
    /// `true` when deterministic fallback was used instead of a provider decision.
    pub degraded: bool,
    /// Bounded observable provider rejections.
    pub rejected: Vec<RejectedSelection>,
    /// Additional rejected entries omitted after the rejection observation budget was exhausted.
    pub rejection_overflow: usize,
    /// Explicit authority and consent boundary.
    pub advisory: &'static str,
}

/// Parses a JSON provider response while requiring every `selectedSlugs` entry to be a string.
///
/// Optional rationale and confidence fields with the wrong JSON type are treated as absent, which
/// matches provider normalization behavior without accepting malformed selection identifiers.
///
/// # Errors
///
/// Returns a decision-structure error, [`MatchingError::TooManySelections`], or
/// [`MatchingError::InvalidCandidateId`] before cloning malformed or oversized identifiers.
pub fn parse_provider_decision(
    value: &Value,
    policy: DecisionPolicy,
) -> Result<ProviderDecisionInput, MatchingError> {
    let object = value.as_object().ok_or(MatchingError::DecisionNotObject)?;
    let selected = object
        .get("selectedSlugs")
        .and_then(Value::as_array)
        .ok_or(MatchingError::MissingSelections)?;
    if selected.len() > policy.max_selected_entries {
        return Err(MatchingError::TooManySelections {
            actual: selected.len(),
            maximum: policy.max_selected_entries,
        });
    }
    let selected_slugs = selected
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let slug = value
                .as_str()
                .ok_or(MatchingError::SelectionNotString { index })?;
            validate_candidate_id(slug)
                .map_err(|reason| MatchingError::InvalidCandidateId { index, reason })?;
            Ok::<String, MatchingError>(slug.to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ProviderDecisionInput {
        selected_slugs,
        rationale: object
            .get("rationale")
            .and_then(Value::as_str)
            .map(|value| bounded_trim(value, policy.max_rationale_characters)),
        confidence: object.get("confidence").and_then(Value::as_f64),
    })
}

/// Applies allowlist validation, stable deduplication, bounded rejection reporting, and confidence
/// normalization to a provider decision.
///
/// Unknown or invalid candidate identifiers never enter `selected_slugs`; each rejection remains
/// observable up to the configured budget. Non-finite confidence becomes `None`, while finite
/// values are clamped to `0.0..=1.0`.
///
/// # Errors
///
/// Returns [`MatchingError::TooManySelections`] or [`MatchingError::TooManyCandidates`] before
/// processing an oversized provider response or allowlist.
pub fn normalize_provider_decision<S: AsRef<str>>(
    input: ProviderDecisionInput,
    allowed_slugs: &[S],
    policy: DecisionPolicy,
) -> Result<RouteDecision, MatchingError> {
    if input.selected_slugs.len() > policy.max_selected_entries {
        return Err(MatchingError::TooManySelections {
            actual: input.selected_slugs.len(),
            maximum: policy.max_selected_entries,
        });
    }
    if allowed_slugs.len() > policy.max_allowed_candidates {
        return Err(MatchingError::TooManyCandidates {
            actual: allowed_slugs.len(),
            maximum: policy.max_allowed_candidates,
        });
    }

    let allowed: HashSet<&str> = allowed_slugs
        .iter()
        .map(AsRef::as_ref)
        .filter(|slug| validate_candidate_id(slug).is_ok())
        .collect();
    let mut seen = HashSet::new();
    let mut selected_slugs = Vec::new();
    let mut rejected = Vec::new();
    let mut rejection_overflow = 0_usize;
    for (index, slug) in input.selected_slugs.into_iter().enumerate() {
        let reason = if validate_candidate_id(&slug).is_err() {
            Some(RejectionReason::InvalidCandidateId)
        } else if !allowed.contains(slug.as_str()) {
            Some(RejectionReason::UnknownCandidate)
        } else if !seen.insert(slug.clone()) {
            Some(RejectionReason::DuplicateCandidate)
        } else {
            selected_slugs.push(slug.clone());
            None
        };
        if let Some(reason) = reason {
            if rejected.len() < policy.max_rejections {
                let (preview, truncated) =
                    truncate_chars_observed(&slug, policy.max_observed_slug_characters);
                rejected.push(RejectedSelection {
                    index,
                    truncated,
                    slug: preview,
                    reason,
                });
            } else {
                rejection_overflow += 1;
            }
        }
    }

    let rationale = input.rationale.map_or_else(
        || "Provider selected from the caller-authorized candidate set.".to_owned(),
        |value| bounded_trim(&value, policy.max_rationale_characters),
    );
    let confidence = input
        .confidence
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0));
    Ok(RouteDecision {
        selected_slugs,
        source: DecisionSource::Provider,
        rationale,
        confidence,
        degraded: false,
        rejected,
        rejection_overflow,
        advisory: MATCHING_ADVISORY_NOTICE,
    })
}
