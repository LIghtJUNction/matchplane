use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// ASCII token grammar used alongside one-character CJK tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum AsciiTokenMode {
    /// Contiguous ASCII letters and digits, discarded when shorter than `minimum_length`.
    Alphanumeric {
        /// Minimum ASCII token length.
        minimum_length: usize,
    },
    /// Router identifiers matching an ASCII alphanumeric start followed by `._:-` or alphanumerics.
    RouterIdentifier,
}

/// Ordering applied after token normalization and deduplication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum TokenOrder {
    /// Preserve each unique token's first occurrence, matching router/storefront parity.
    FirstOccurrence,
    /// Sort unique tokens lexicographically, preserving the historical storage behavior.
    Sorted,
}

/// A deterministic bound, grammar, and ordering for multilingual tokenization.
///
/// Character limits count Unicode scalar values, never UTF-8 bytes or UTF-16 code units. This
/// prevents splitting an emoji or producing invalid UTF-8. It intentionally differs from
/// JavaScript `slice`, which counts UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenPolicy {
    max_tokens: usize,
    max_characters: usize,
    ascii_mode: AsciiTokenMode,
    order: TokenOrder,
    deduplicate_before_limit: bool,
}

impl TokenPolicy {
    /// Builds the frontend-router-compatible grammar with an explicit unique-token limit.
    ///
    /// The frontend currently chooses `512`. Callers may select a smaller verified budget.
    #[must_use]
    pub const fn router(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            max_characters: 8_000,
            ascii_mode: AsciiTokenMode::RouterIdentifier,
            order: TokenOrder::FirstOccurrence,
            deduplicate_before_limit: true,
        }
    }

    /// Builds the legacy Rust marketplace grammar with an explicit raw-token limit.
    ///
    /// ASCII tokens require two characters, CJK ideographs remain individual tokens, and the
    /// raw stream is bounded before deduplication. MatchPlane storage passes `256` to preserve
    /// its established ranking behavior.
    #[must_use]
    pub const fn storage_compatible(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            max_characters: 64 * 1_024,
            ascii_mode: AsciiTokenMode::Alphanumeric { minimum_length: 2 },
            order: TokenOrder::Sorted,
            deduplicate_before_limit: false,
        }
    }

    /// Maximum tokens emitted after normalization.
    #[must_use]
    pub const fn max_tokens(self) -> usize {
        self.max_tokens
    }

    /// Maximum input Unicode scalar values inspected.
    #[must_use]
    pub const fn max_characters(self) -> usize {
        self.max_characters
    }

    /// Configured ASCII grammar.
    #[must_use]
    pub const fn ascii_mode(self) -> AsciiTokenMode {
        self.ascii_mode
    }

    /// Configured unique-token ordering.
    #[must_use]
    pub const fn order(self) -> TokenOrder {
        self.order
    }
}

/// Produces unique multilingual tokens under an explicit ordering policy.
///
/// ASCII matching is case-insensitive. Each CJK unified ideograph in `U+3400..=U+9FFF` is a
/// token. Other Unicode characters, including emoji, are safe delimiters rather than tokens.
///
/// # Examples
///
/// ```
/// use matchplane_matching::{TokenPolicy, tokenize};
///
/// let tokens = tokenize("Cargo配送🚲", TokenPolicy::router(512));
/// assert_eq!(tokens, ["cargo", "配", "送"]);
/// ```
#[must_use]
pub fn tokenize(value: &str, policy: TokenPolicy) -> Vec<String> {
    if policy.max_tokens == 0 || policy.max_characters == 0 {
        return Vec::new();
    }

    let raw_limit = if policy.deduplicate_before_limit {
        usize::MAX
    } else {
        policy.max_tokens
    };
    let mut tokens = Vec::new();
    let mut ascii = String::new();

    for character in value
        .chars()
        .take(policy.max_characters)
        .flat_map(char::to_lowercase)
    {
        if character.is_ascii_alphanumeric() {
            ascii.push(character);
            continue;
        }
        if matches!(policy.ascii_mode, AsciiTokenMode::RouterIdentifier)
            && !ascii.is_empty()
            && matches!(character, '.' | '_' | ':' | '-')
        {
            ascii.push(character);
            continue;
        }
        if flush_ascii(&mut tokens, &mut ascii, policy.ascii_mode, raw_limit) {
            break;
        }
        if ('\u{3400}'..='\u{9fff}').contains(&character) {
            tokens.push(character.to_string());
            if tokens.len() >= raw_limit {
                break;
            }
        }
    }
    if tokens.len() < raw_limit {
        flush_ascii(&mut tokens, &mut ascii, policy.ascii_mode, raw_limit);
    }
    match policy.order {
        TokenOrder::FirstOccurrence => {
            let mut seen = HashSet::new();
            tokens.retain(|token| seen.insert(token.clone()));
        }
        TokenOrder::Sorted => {
            tokens.sort_unstable();
            tokens.dedup();
        }
    }
    tokens.truncate(policy.max_tokens);
    tokens
}

fn flush_ascii(
    tokens: &mut Vec<String>,
    ascii: &mut String,
    mode: AsciiTokenMode,
    raw_limit: usize,
) -> bool {
    let minimum_length = match mode {
        AsciiTokenMode::Alphanumeric { minimum_length } => minimum_length,
        AsciiTokenMode::RouterIdentifier => 1,
    };
    if ascii.len() >= minimum_length && tokens.len() < raw_limit {
        tokens.push(std::mem::take(ascii));
    } else {
        ascii.clear();
    }
    tokens.len() >= raw_limit
}

pub(crate) fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

pub(crate) fn truncate_chars_observed(value: &str, maximum: usize) -> (String, bool) {
    let mut characters = value.chars();
    let preview = characters.by_ref().take(maximum).collect();
    (preview, characters.next().is_some())
}

pub(crate) fn bounded_trim(value: &str, maximum: usize) -> String {
    let inspection_limit = maximum.saturating_mul(2).saturating_add(1);
    let prefix: String = value
        .chars()
        .take(inspection_limit)
        .skip_while(|character| character.is_whitespace())
        .take(maximum.saturating_add(1))
        .collect();
    truncate_chars(prefix.trim_end(), maximum)
}

pub(crate) fn bounded_prefixed(prefix: &str, value: &str, maximum_characters: usize) -> String {
    prefix
        .chars()
        .chain(value.chars())
        .take(maximum_characters)
        .collect()
}

pub(crate) fn bounded_join<'a, I>(values: I, separator: char, maximum_characters: usize) -> String
where
    I: IntoIterator<Item = &'a str>,
{
    let mut output = String::new();
    let mut remaining = maximum_characters;
    for value in values {
        if remaining == 0 {
            break;
        }
        if !output.is_empty() {
            output.push(separator);
            remaining = remaining.saturating_sub(1);
        }
        for character in value.chars().take(remaining) {
            output.push(character);
            remaining -= 1;
        }
    }
    output
}
