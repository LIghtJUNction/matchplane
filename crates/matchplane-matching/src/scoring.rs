use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{MATCHING_ADVISORY_NOTICE, TokenPolicy, token::bounded_prefixed, tokenize};

/// Bounded work budget for structured attribute comparison and supply-text collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuredDataBudget {
    max_attributes: usize,
    max_key_bytes: usize,
    max_value_bytes: usize,
    max_value_nodes: usize,
    max_nesting_depth: usize,
}

impl StructuredDataBudget {
    /// Creates an explicit aggregate structured-data inspection budget.
    #[must_use]
    pub const fn new(
        max_attributes: usize,
        max_key_bytes: usize,
        max_value_bytes: usize,
        max_value_nodes: usize,
        max_nesting_depth: usize,
    ) -> Self {
        Self {
            max_attributes,
            max_key_bytes,
            max_value_bytes,
            max_value_nodes,
            max_nesting_depth,
        }
    }
}

impl Default for StructuredDataBudget {
    fn default() -> Self {
        Self::new(64, 256, 64 * 1_024, 8 * 1_024, 24)
    }
}

/// Bounds for deterministic structured-attribute and narrative scoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuredScorePolicy {
    token_policy: TokenPolicy,
    data_budget: StructuredDataBudget,
    max_attribute_reasons: usize,
    max_narrative_reasons: usize,
    max_reason_characters: usize,
}

impl StructuredScorePolicy {
    /// Creates an explicit bounded scoring policy.
    #[must_use]
    pub const fn new(
        token_policy: TokenPolicy,
        data_budget: StructuredDataBudget,
        max_attribute_reasons: usize,
        max_narrative_reasons: usize,
        max_reason_characters: usize,
    ) -> Self {
        Self {
            token_policy,
            data_budget,
            max_attribute_reasons,
            max_narrative_reasons,
            max_reason_characters,
        }
    }

    /// Reproduces MatchPlane storage token ordering with production request-sized data budgets.
    #[must_use]
    pub const fn storage_compatible(max_tokens: usize) -> Self {
        Self::new(
            TokenPolicy::storage_compatible(max_tokens),
            StructuredDataBudget::new(256, 500, 128 * 1_024, 16 * 1_024, 32),
            8,
            8,
            500,
        )
    }

    /// Token policy used by this score.
    #[must_use]
    pub const fn token_policy(self) -> TokenPolicy {
        self.token_policy
    }

    /// Structured-data inspection budget used by this score.
    #[must_use]
    pub const fn data_budget(self) -> StructuredDataBudget {
        self.data_budget
    }
}

impl Default for StructuredScorePolicy {
    fn default() -> Self {
        Self::new(
            TokenPolicy::router(512),
            StructuredDataBudget::new(64, 256, 64 * 1_024, 8 * 1_024, 24),
            4,
            4,
            240,
        )
    }
}

/// A bounded deterministic recommendation score and its public explanation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StructuredMatch {
    /// Score in the inclusive `0.0..=1.0` range.
    pub score: f64,
    /// Deterministic, policy-bounded explanation fragments.
    pub reasons: Vec<String>,
    /// Demand attributes inspected under policy.
    pub inspected_attributes: usize,
    /// Demand attributes omitted after the attribute-count budget.
    pub omitted_attributes: usize,
    /// Comparisons skipped after key, byte, node, or nesting budgets were exhausted.
    pub budget_rejections: usize,
    /// Reminder that this score grants no authority or consent.
    pub advisory: &'static str,
}

/// Scores exact structured attributes and multilingual narrative overlap.
///
/// This function invokes no model. It inspects only the configured number of demand attributes and
/// compares nested values under aggregate byte, node, and depth budgets. Null demand attributes are
/// treated as unspecified: they are inspected but never considered, matched, or explained. Supply
/// metadata is walked directly into a bounded token buffer; the complete JSON value is never
/// serialized or copied.
///
/// # Examples
///
/// ```
/// use matchplane_matching::{StructuredScorePolicy, score_structured};
/// use serde_json::json;
///
/// let result = score_structured(
///     "新能源配送", &json!({"region": "cn"}), "城市新能源配送",
///     &json!({"region": "cn"}), StructuredScorePolicy::default(),
/// );
/// assert!(result.score > 0.7);
/// assert_eq!(result.omitted_attributes, 0);
/// ```
#[must_use]
pub fn score_structured(
    narrative: &str,
    demand: &Value,
    supply_name: &str,
    supply: &Value,
    policy: StructuredScorePolicy,
) -> StructuredMatch {
    let (Some(demand), Some(supply)) = (demand.as_object(), supply.as_object()) else {
        return empty_structured_match();
    };

    let mut matched = 0_usize;
    let mut considered = 0_usize;
    let mut reasons = Vec::new();
    let mut budget_rejections = 0_usize;
    let mut inspected_attributes = 0_usize;
    let mut inspection = InspectionBudget::new(policy.data_budget);
    for (key, value) in demand.iter().take(policy.data_budget.max_attributes) {
        inspected_attributes += 1;
        if value.is_null() {
            continue;
        }
        considered += 1;
        let Some(supply_value) = supply.get(key) else {
            continue;
        };
        if key.len() > policy.data_budget.max_key_bytes {
            budget_rejections += 1;
            continue;
        }
        match bounded_value_equal(
            value,
            supply_value,
            &mut inspection,
            0,
            policy.data_budget.max_nesting_depth,
        ) {
            Some(true) => {
                matched += 1;
                if reasons.len() < policy.max_attribute_reasons {
                    push_reason(
                        &mut reasons,
                        "shared attribute: ",
                        key,
                        policy.max_reason_characters,
                    );
                }
            }
            Some(false) => {}
            None => budget_rejections += 1,
        }
    }
    let omitted_attributes = demand.len().saturating_sub(inspected_attributes);
    let attribute_score = ratio(matched, considered);

    let narrative_tokens = tokenize(narrative, policy.token_policy);
    let supply_text = bounded_supply_text(supply_name, supply, policy);
    let supply_tokens: HashSet<String> = tokenize(&supply_text, policy.token_policy)
        .into_iter()
        .collect();
    let narrative_matches: Vec<&String> = narrative_tokens
        .iter()
        .filter(|token| supply_tokens.contains(*token))
        .collect();
    let narrative_score = ratio(narrative_matches.len(), narrative_tokens.len());
    for token in narrative_matches
        .into_iter()
        .take(policy.max_narrative_reasons)
    {
        push_reason(
            &mut reasons,
            "narrative_match:",
            token,
            policy.max_reason_characters,
        );
    }

    let score = match (considered, narrative_tokens.is_empty()) {
        (0, true) => 0.0,
        (0, false) => narrative_score,
        (_, true) => attribute_score,
        (_, false) => attribute_score.mul_add(0.7, narrative_score * 0.3),
    };
    StructuredMatch {
        score: score.clamp(0.0, 1.0),
        reasons,
        inspected_attributes,
        omitted_attributes,
        budget_rejections,
        advisory: MATCHING_ADVISORY_NOTICE,
    }
}

fn empty_structured_match() -> StructuredMatch {
    StructuredMatch {
        score: 0.0,
        reasons: Vec::new(),
        inspected_attributes: 0,
        omitted_attributes: 0,
        budget_rejections: 0,
        advisory: MATCHING_ADVISORY_NOTICE,
    }
}

#[derive(Clone, Copy)]
struct InspectionBudget {
    remaining_bytes: usize,
    remaining_nodes: usize,
}

impl InspectionBudget {
    const fn new(policy: StructuredDataBudget) -> Self {
        Self {
            remaining_bytes: policy.max_value_bytes,
            remaining_nodes: policy.max_value_nodes,
        }
    }

    fn consume_node(&mut self) -> bool {
        if self.remaining_nodes == 0 {
            return false;
        }
        self.remaining_nodes -= 1;
        true
    }

    fn consume_bytes(&mut self, amount: usize) -> bool {
        if amount > self.remaining_bytes {
            self.remaining_bytes = 0;
            return false;
        }
        self.remaining_bytes -= amount;
        true
    }
}

fn bounded_value_equal(
    left: &Value,
    right: &Value,
    budget: &mut InspectionBudget,
    depth: usize,
    max_depth: usize,
) -> Option<bool> {
    if depth > max_depth || !budget.consume_node() {
        return None;
    }
    match (left, right) {
        (Value::Null, Value::Null) => Some(true),
        (Value::Bool(left), Value::Bool(right)) => Some(left == right),
        (Value::Number(left), Value::Number(right)) => Some(left == right),
        (Value::String(left), Value::String(right)) => budget
            .consume_bytes(left.len().saturating_add(right.len()))
            .then(|| left == right),
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                return Some(false);
            }
            for (left, right) in left.iter().zip(right) {
                if !bounded_value_equal(left, right, budget, depth + 1, max_depth)? {
                    return Some(false);
                }
            }
            Some(true)
        }
        (Value::Object(left), Value::Object(right)) => {
            if left.len() != right.len() {
                return Some(false);
            }
            for (key, left_value) in left {
                if !budget.consume_bytes(key.len()) {
                    return None;
                }
                let Some(right_value) = right.get(key) else {
                    return Some(false);
                };
                if !bounded_value_equal(left_value, right_value, budget, depth + 1, max_depth)? {
                    return Some(false);
                }
            }
            Some(true)
        }
        _ => Some(false),
    }
}

fn bounded_supply_text(
    supply_name: &str,
    supply: &serde_json::Map<String, Value>,
    policy: StructuredScorePolicy,
) -> String {
    let mut output = String::new();
    let mut remaining_characters = policy.token_policy.max_characters();
    let mut budget = InspectionBudget::new(policy.data_budget);
    append_text(
        &mut output,
        supply_name,
        &mut remaining_characters,
        &mut budget,
    );
    for (key, value) in supply {
        if remaining_characters == 0 || !budget.consume_node() {
            break;
        }
        append_separator(&mut output, &mut remaining_characters);
        append_text(&mut output, key, &mut remaining_characters, &mut budget);
        append_separator(&mut output, &mut remaining_characters);
        append_value_text(
            &mut output,
            value,
            &mut remaining_characters,
            &mut budget,
            0,
            policy.data_budget.max_nesting_depth,
        );
    }
    output
}

fn append_value_text(
    output: &mut String,
    value: &Value,
    remaining_characters: &mut usize,
    budget: &mut InspectionBudget,
    depth: usize,
    max_depth: usize,
) {
    if *remaining_characters == 0 || depth > max_depth || !budget.consume_node() {
        return;
    }
    match value {
        Value::Null => append_text(output, "null", remaining_characters, budget),
        Value::Bool(value) => append_text(
            output,
            if *value { "true" } else { "false" },
            remaining_characters,
            budget,
        ),
        Value::Number(value) => {
            let value = value.to_string();
            append_text(output, &value, remaining_characters, budget);
        }
        Value::String(value) => append_text(output, value, remaining_characters, budget),
        Value::Array(values) => {
            for value in values {
                append_separator(output, remaining_characters);
                append_value_text(
                    output,
                    value,
                    remaining_characters,
                    budget,
                    depth + 1,
                    max_depth,
                );
                if *remaining_characters == 0 || budget.remaining_nodes == 0 {
                    break;
                }
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                append_separator(output, remaining_characters);
                append_text(output, key, remaining_characters, budget);
                append_separator(output, remaining_characters);
                append_value_text(
                    output,
                    value,
                    remaining_characters,
                    budget,
                    depth + 1,
                    max_depth,
                );
                if *remaining_characters == 0 || budget.remaining_nodes == 0 {
                    break;
                }
            }
        }
    }
}

fn append_text(
    output: &mut String,
    value: &str,
    remaining_characters: &mut usize,
    budget: &mut InspectionBudget,
) {
    for character in value.chars().take(*remaining_characters) {
        let bytes = character.len_utf8();
        if !budget.consume_bytes(bytes) {
            break;
        }
        output.push(character);
        *remaining_characters -= 1;
    }
}

fn append_separator(output: &mut String, remaining_characters: &mut usize) {
    if !output.is_empty() && *remaining_characters > 0 {
        output.push(' ');
        *remaining_characters -= 1;
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn push_reason(reasons: &mut Vec<String>, prefix: &str, value: &str, maximum: usize) {
    if maximum == 0 {
        return;
    }
    reasons.push(bounded_prefixed(prefix, value, maximum));
}
