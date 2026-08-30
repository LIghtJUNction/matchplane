use thiserror::Error;

use crate::identity::CandidateIdError;

/// Errors raised while validating provider decisions or constructing bounded payloads.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum MatchingError {
    /// The provider decision was not a JSON object.
    #[error("provider decision must be a JSON object")]
    DecisionNotObject,
    /// The provider decision did not contain a `selectedSlugs` array.
    #[error("provider decision must contain a selectedSlugs array")]
    MissingSelections,
    /// One `selectedSlugs` entry was not a string.
    #[error("provider selectedSlugs entry at index {index} must be a string")]
    SelectionNotString {
        /// Zero-based index of the malformed selection.
        index: usize,
    },
    /// The provider returned more entries than the configured validation budget.
    #[error("provider returned {actual} selections, exceeding the limit of {maximum}")]
    TooManySelections {
        /// Number of entries returned by the provider.
        actual: usize,
        /// Maximum entries accepted by policy.
        maximum: usize,
    },
    /// More candidates were supplied than the active matching boundary permits.
    #[error("received {actual} candidates, exceeding the limit of {maximum}")]
    TooManyCandidates {
        /// Number of supplied candidates.
        actual: usize,
        /// Maximum candidates accepted by policy.
        maximum: usize,
    },
    /// A candidate identifier failed the shared exact-identity boundary.
    #[error("invalid candidate identifier at index {index}: {reason}")]
    InvalidCandidateId {
        /// Zero-based candidate or selection index.
        index: usize,
        /// Exact validation failure; the identifier itself is never truncated into output.
        #[source]
        reason: CandidateIdError,
    },
    /// The compact, valid JSON payload could not fit the configured byte budget.
    #[error("compact provider payload is {actual} bytes, exceeding the limit of {maximum}")]
    PayloadTooLarge {
        /// Serialized UTF-8 byte length.
        actual: usize,
        /// Maximum serialized UTF-8 byte length.
        maximum: usize,
    },
    /// JSON serialization failed.
    #[error("provider payload serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}
