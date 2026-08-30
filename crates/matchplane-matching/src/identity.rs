use thiserror::Error;

/// Maximum characters and UTF-8 bytes in a candidate selection identifier.
///
/// Candidate identifiers are restricted to ASCII alphanumerics plus `.`, `_`, `:`, and `-`, so
/// this character limit is also the byte limit. Identity values are never truncated.
pub const MAX_CANDIDATE_ID_CHARACTERS: usize = 120;

/// Why a candidate selection identifier is invalid.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum CandidateIdError {
    /// The identifier contained no characters.
    #[error("candidate identifier must not be empty")]
    Empty,
    /// The identifier exceeded [`MAX_CANDIDATE_ID_CHARACTERS`].
    #[error("candidate identifier exceeds the maximum of {maximum} ASCII characters")]
    TooLong {
        /// Maximum accepted characters.
        maximum: usize,
    },
    /// The identifier contained a character outside the public ASCII grammar.
    #[error("candidate identifier contains a disallowed character at index {index}")]
    InvalidCharacter {
        /// Zero-based Unicode scalar index of the invalid character.
        index: usize,
    },
}

/// Validates an exact candidate selection identifier without allocating or truncating it.
///
/// The public grammar is `[A-Za-z0-9._:-]{1,120}`. Validation inspects at most 121 characters even
/// if an untrusted input string is much larger.
///
/// # Errors
///
/// Returns [`CandidateIdError`] for empty, overlong, or non-grammar identifiers.
pub fn validate_candidate_id(value: &str) -> Result<(), CandidateIdError> {
    if value.is_empty() {
        return Err(CandidateIdError::Empty);
    }
    for (index, character) in value
        .chars()
        .take(MAX_CANDIDATE_ID_CHARACTERS + 1)
        .enumerate()
    {
        if index == MAX_CANDIDATE_ID_CHARACTERS {
            return Err(CandidateIdError::TooLong {
                maximum: MAX_CANDIDATE_ID_CHARACTERS,
            });
        }
        if !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')) {
            return Err(CandidateIdError::InvalidCharacter { index });
        }
    }
    Ok(())
}
