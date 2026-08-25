#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![doc = include_str!("../README.md")]

mod error;
mod identity;
mod lexical;
mod payload;
mod provider;
mod routing;
mod scoring;
mod token;

pub use error::MatchingError;
pub use identity::{CandidateIdError, MAX_CANDIDATE_ID_CHARACTERS, validate_candidate_id};
pub use lexical::{
    LexicalCandidate, LexicalRankPolicy, RankedLexicalCandidate, rank_lexical_candidates,
};
pub use payload::{
    BoundedProviderPayload, COMPACT_IDENTITY_CHARACTERS, COMPACT_NARRATIVE_CHARACTERS,
    DETAILED_AGENT_SKILL_CHARACTERS, DETAILED_AGENT_SKILLS, DETAILED_AGENT_STAGE_CHARACTERS,
    DETAILED_AGENT_STAGES, DETAILED_CAPABILITIES, DETAILED_CAPABILITY_CHARACTERS,
    DETAILED_DESCRIPTION_CHARACTERS, DETAILED_DISPLAY_NAME_CHARACTERS,
    DETAILED_NARRATIVE_CHARACTERS, PayloadMode, ProviderPayloadPolicy, build_provider_payload,
};
pub use provider::{
    DecisionPolicy, DecisionSource, ProviderDecisionInput, RejectedSelection, RejectionReason,
    RouteDecision, normalize_provider_decision, parse_provider_decision,
};
pub use routing::{
    CandidateWindowPolicy, FallbackPolicy, RouteCandidate, deterministic_fallback,
    rank_fallback_candidates, select_candidate_window, stable_hash,
};
pub use scoring::{StructuredDataBudget, StructuredMatch, StructuredScorePolicy, score_structured};
pub use token::{AsciiTokenMode, TokenOrder, TokenPolicy, tokenize};

/// Every result from this crate is advisory only. It grants no authorization, contact consent,
/// payment authority, contractual acceptance, or other right.
pub const MATCHING_ADVISORY_NOTICE: &str = "Matching results are recommendations only; they grant no authorization, contact consent, payment authority, contractual acceptance, or other right.";
