use serde::Serialize;

use crate::{
    MAX_CANDIDATE_ID_CHARACTERS, MatchingError, RouteCandidate, token::truncate_chars,
    validate_candidate_id,
};

/// Maximum detailed user-intent Unicode scalar values.
pub const DETAILED_NARRATIVE_CHARACTERS: usize = 8_000;
/// Maximum compact user-intent Unicode scalar values and escaped-content bytes.
pub const COMPACT_NARRATIVE_CHARACTERS: usize = 4_000;
/// Maximum detailed candidate display-name Unicode scalar values.
pub const DETAILED_DISPLAY_NAME_CHARACTERS: usize = 160;
/// Maximum detailed candidate description Unicode scalar values.
pub const DETAILED_DESCRIPTION_CHARACTERS: usize = 400;
/// Maximum detailed capabilities per candidate.
pub const DETAILED_CAPABILITIES: usize = 16;
/// Maximum Unicode scalar values per detailed capability.
pub const DETAILED_CAPABILITY_CHARACTERS: usize = 96;
/// Maximum detailed agent stages per candidate.
pub const DETAILED_AGENT_STAGES: usize = 8;
/// Maximum Unicode scalar values per detailed agent stage.
pub const DETAILED_AGENT_STAGE_CHARACTERS: usize = 96;
/// Maximum detailed agent skills per candidate.
pub const DETAILED_AGENT_SKILLS: usize = 16;
/// Maximum Unicode scalar values per detailed agent skill.
pub const DETAILED_AGENT_SKILL_CHARACTERS: usize = 128;
/// Maximum compact path or display-name Unicode scalar values.
///
/// Candidate slugs use the same numeric boundary through
/// [`crate::MAX_CANDIDATE_ID_CHARACTERS`] and are validated rather than truncated.
pub const COMPACT_IDENTITY_CHARACTERS: usize = MAX_CANDIDATE_ID_CHARACTERS;

/// Provider-payload mode selected after serialization-aware compaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum PayloadMode {
    /// Includes bounded descriptions, capabilities, stages, and skills.
    Detailed,
    /// Includes only bounded identity fields required for an allowlisted decision.
    Compact,
}

/// Top-level bounds for a provider intent payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderPayloadPolicy {
    max_candidates: usize,
    max_serialized_bytes: usize,
}

impl ProviderPayloadPolicy {
    /// Creates a payload policy with explicit candidate and serialized UTF-8 byte limits.
    #[must_use]
    pub const fn new(max_candidates: usize, max_serialized_bytes: usize) -> Self {
        Self {
            max_candidates,
            max_serialized_bytes,
        }
    }
}

impl Default for ProviderPayloadPolicy {
    fn default() -> Self {
        Self::new(32, 24_000)
    }
}

/// A complete valid JSON provider payload and the compaction mode used to build it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedProviderPayload {
    /// Complete valid JSON; it is never a truncated serialized string.
    pub json: String,
    /// Detailed or compact structure used for the final serialization.
    pub mode: PayloadMode,
    /// UTF-8 byte length of `json`.
    pub serialized_bytes: usize,
}

/// Builds a bounded provider-neutral intent payload.
///
/// The function first serializes a detailed bounded structure. If that exceeds the byte budget,
/// it rebuilds and serializes a compact structure; it never slices serialized JSON. Compact text
/// also uses an escaped-content byte budget, so quotes, control characters, CJK, and emoji cannot
/// invalidate or silently exceed the default 24,000-byte boundary.
///
/// Candidate slugs are provider selection keys and are therefore validated against the shared
/// [`crate::validate_candidate_id`] boundary rather than truncated.
///
/// # Errors
///
/// Returns [`MatchingError::TooManyCandidates`], [`MatchingError::InvalidCandidateId`],
/// [`MatchingError::PayloadTooLarge`], or [`MatchingError::Serialization`].
///
/// # Examples
///
/// ```
/// use matchplane_matching::{ProviderPayloadPolicy, RouteCandidate, build_provider_payload};
///
/// let candidate = RouteCandidate {
///     slug: "bikes".into(), path: "/bikes".into(), display_name: "自行车".into(),
///     description: "城市通勤".into(), capabilities: vec!["catalog.search".into()],
///     agent_stages: vec!["retrieval".into()], agent_skills: vec!["bike-fit".into()],
/// };
/// let payload = build_provider_payload(
///     "/", "通勤自行车", &[candidate], ProviderPayloadPolicy::default()
/// ).unwrap();
/// let parsed: serde_json::Value = serde_json::from_str(&payload.json).unwrap();
/// assert_eq!(parsed["candidates"][0]["slug"], "bikes");
/// ```
pub fn build_provider_payload(
    current_platform_path: &str,
    narrative: &str,
    candidates: &[RouteCandidate],
    policy: ProviderPayloadPolicy,
) -> Result<BoundedProviderPayload, MatchingError> {
    if candidates.len() > policy.max_candidates {
        return Err(MatchingError::TooManyCandidates {
            actual: candidates.len(),
            maximum: policy.max_candidates,
        });
    }
    validate_slugs(candidates)?;

    let detailed = DetailedPayload {
        current_platform_path: truncate_chars(current_platform_path, 256),
        user_intent: truncate_chars(narrative, DETAILED_NARRATIVE_CHARACTERS),
        candidates: candidates.iter().map(DetailedCandidate::from).collect(),
    };
    let detailed_json = serde_json::to_string(&detailed)?;
    if detailed_json.len() <= policy.max_serialized_bytes {
        let serialized_bytes = detailed_json.len();
        return Ok(BoundedProviderPayload {
            json: detailed_json,
            mode: PayloadMode::Detailed,
            serialized_bytes,
        });
    }

    let compact = CompactPayload {
        current_platform_path: bounded_json_text(
            current_platform_path,
            COMPACT_IDENTITY_CHARACTERS,
            COMPACT_IDENTITY_CHARACTERS,
        ),
        user_intent: bounded_json_text(
            narrative,
            COMPACT_NARRATIVE_CHARACTERS,
            COMPACT_NARRATIVE_CHARACTERS,
        ),
        candidates: candidates.iter().map(CompactCandidate::from).collect(),
    };
    let compact_json = serde_json::to_string(&compact)?;
    if compact_json.len() > policy.max_serialized_bytes {
        return Err(MatchingError::PayloadTooLarge {
            actual: compact_json.len(),
            maximum: policy.max_serialized_bytes,
        });
    }
    let serialized_bytes = compact_json.len();
    Ok(BoundedProviderPayload {
        json: compact_json,
        mode: PayloadMode::Compact,
        serialized_bytes,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailedPayload {
    current_platform_path: String,
    user_intent: String,
    candidates: Vec<DetailedCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailedCandidate {
    slug: String,
    path: String,
    display_name: String,
    description: String,
    capabilities: Vec<String>,
    agent_stages: Vec<String>,
    agent_skills: Vec<String>,
}

impl From<&RouteCandidate> for DetailedCandidate {
    fn from(candidate: &RouteCandidate) -> Self {
        Self {
            slug: candidate.slug.clone(),
            path: truncate_chars(&candidate.path, 256),
            display_name: truncate_chars(&candidate.display_name, DETAILED_DISPLAY_NAME_CHARACTERS),
            description: truncate_chars(&candidate.description, DETAILED_DESCRIPTION_CHARACTERS),
            capabilities: bounded_list(
                &candidate.capabilities,
                DETAILED_CAPABILITIES,
                DETAILED_CAPABILITY_CHARACTERS,
            ),
            agent_stages: bounded_list(
                &candidate.agent_stages,
                DETAILED_AGENT_STAGES,
                DETAILED_AGENT_STAGE_CHARACTERS,
            ),
            agent_skills: bounded_list(
                &candidate.agent_skills,
                DETAILED_AGENT_SKILLS,
                DETAILED_AGENT_SKILL_CHARACTERS,
            ),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactPayload {
    current_platform_path: String,
    user_intent: String,
    candidates: Vec<CompactCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactCandidate {
    slug: String,
    path: String,
    display_name: String,
}

impl From<&RouteCandidate> for CompactCandidate {
    fn from(candidate: &RouteCandidate) -> Self {
        Self {
            slug: candidate.slug.clone(),
            path: bounded_json_text(
                &candidate.path,
                COMPACT_IDENTITY_CHARACTERS,
                COMPACT_IDENTITY_CHARACTERS,
            ),
            display_name: bounded_json_text(
                &candidate.display_name,
                COMPACT_IDENTITY_CHARACTERS,
                COMPACT_IDENTITY_CHARACTERS,
            ),
        }
    }
}

fn validate_slugs(candidates: &[RouteCandidate]) -> Result<(), MatchingError> {
    for (index, candidate) in candidates.iter().enumerate() {
        validate_candidate_id(&candidate.slug)
            .map_err(|reason| MatchingError::InvalidCandidateId { index, reason })?;
    }
    Ok(())
}

fn bounded_list(values: &[String], maximum: usize, maximum_characters: usize) -> Vec<String> {
    values
        .iter()
        .take(maximum)
        .map(|value| truncate_chars(value, maximum_characters))
        .collect()
}

fn bounded_json_text(value: &str, max_characters: usize, max_content_bytes: usize) -> String {
    let mut result = String::new();
    let mut content_bytes = 0_usize;
    for character in value.chars().take(max_characters) {
        let character_bytes = json_character_bytes(character);
        if content_bytes.saturating_add(character_bytes) > max_content_bytes {
            break;
        }
        result.push(character);
        content_bytes += character_bytes;
    }
    result
}

fn json_character_bytes(character: char) -> usize {
    match character {
        '"' | '\\' | '\u{0008}' | '\u{000c}' | '\n' | '\r' | '\t' => 2,
        '\u{0000}'..='\u{001f}' => 6,
        _ => character.len_utf8(),
    }
}
