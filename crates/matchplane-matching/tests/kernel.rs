//! Public API, determinism, Unicode, provider-boundary, and payload-boundary tests.

use matchplane_matching::{
    CandidateIdError, CandidateWindowPolicy, DecisionPolicy, DecisionSource, FallbackPolicy,
    LexicalCandidate, LexicalRankPolicy, MATCHING_ADVISORY_NOTICE, MAX_CANDIDATE_ID_CHARACTERS,
    MatchingError, PayloadMode, ProviderDecisionInput, ProviderPayloadPolicy, RejectionReason,
    RouteCandidate, StructuredDataBudget, StructuredScorePolicy, TokenOrder, TokenPolicy,
    build_provider_payload, deterministic_fallback, normalize_provider_decision,
    parse_provider_decision, rank_fallback_candidates, rank_lexical_candidates, score_structured,
    select_candidate_window, stable_hash, tokenize, validate_candidate_id,
};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn bounded_candidate_window_is_stable_and_overlap_first() -> TestResult {
    let small = (0..4).map(candidate).collect::<Vec<_>>();
    let unchanged =
        select_candidate_window(&small, "not present", CandidateWindowPolicy::default())?;
    assert_eq!(
        slugs(&unchanged),
        ["store-0", "store-1", "store-2", "store-3"]
    );

    let mut large = (0..40).map(candidate).collect::<Vec<_>>();
    for (index, candidate) in large.iter_mut().enumerate() {
        if index % 2 == 0 {
            candidate.description = "rare cargo bicycle".to_owned();
        }
    }
    let first = select_candidate_window(&large, "cargo bicycle", CandidateWindowPolicy::default())?;
    let second =
        select_candidate_window(&large, "cargo bicycle", CandidateWindowPolicy::default())?;
    assert_eq!(first.len(), 32);
    assert_eq!(slugs(&first), slugs(&second));
    assert!(
        first[..20]
            .iter()
            .all(|candidate| { candidate.description == "rare cargo bicycle" })
    );
    Ok(())
}

#[test]
fn fnv_hash_and_fallback_order_are_deterministic() -> TestResult {
    assert_eq!(stable_hash("hello"), 0x4f9f_2cab);
    let candidates = (0..5).map(candidate).collect::<Vec<_>>();
    let ranked = rank_fallback_candidates(
        &candidates,
        "不存在",
        FallbackPolicy::new(32, 32, 1_000, TokenPolicy::router(512)),
    )?;
    assert_eq!(
        slugs(&ranked),
        ["store-0", "store-1", "store-2", "store-3", "store-4"]
    );

    let decision = deterministic_fallback(
        &candidates,
        "不存在",
        Some("provider unavailable"),
        FallbackPolicy::default(),
    )?;
    assert_eq!(decision.source, DecisionSource::DeterministicFallback);
    assert_eq!(
        decision.selected_slugs,
        ["store-0", "store-1", "store-2", "store-3"]
    );
    assert_eq!(decision.confidence, None);
    assert!(decision.degraded);
    assert_eq!(decision.advisory, MATCHING_ADVISORY_NOTICE);
    assert!(decision.rationale.contains("no model confidence"));
    Ok(())
}

#[test]
fn token_policies_are_explicit_multilingual_and_unicode_safe() {
    assert_eq!(
        tokenize("Cargo配送🚲", TokenPolicy::router(512)),
        ["cargo", "配", "送"]
    );
    assert_eq!(
        tokenize("a x cargo-bike", TokenPolicy::storage_compatible(256)),
        ["bike", "cargo"]
    );
    assert_eq!(
        tokenize("a x cargo-bike", TokenPolicy::router(512)),
        ["a", "x", "cargo-bike"]
    );
    assert_eq!(
        TokenPolicy::router(512).order(),
        TokenOrder::FirstOccurrence
    );
    assert_eq!(
        TokenPolicy::storage_compatible(256).order(),
        TokenOrder::Sorted
    );
    assert_eq!(
        tokenize("bike 配 bike 送 配", TokenPolicy::router(512)),
        ["bike", "配", "送"]
    );
    assert_eq!(
        tokenize("bike 配 bike 送 配", TokenPolicy::storage_compatible(256)),
        ["bike", "送", "配"]
    );

    let many_cjk = (0..300)
        .filter_map(|offset| char::from_u32(0x3400 + offset))
        .collect::<String>();
    assert_eq!(
        tokenize(&many_cjk, TokenPolicy::storage_compatible(256)).len(),
        256
    );
}

#[test]
fn structured_score_is_deterministic_multilingual_and_bounded() {
    let policy = StructuredScorePolicy::new(
        TokenPolicy::storage_compatible(256),
        StructuredDataBudget::new(8, 64, 4_096, 256, 8),
        2,
        2,
        24,
    );
    let first = score_structured(
        "新能源 service 配送",
        &json!({"kind": "service", "region": "cn", "capacity": 4}),
        "城市新能源 service 配送",
        &json!({"kind": "service", "region": "cn", "capacity": 2}),
        policy,
    );
    let second = score_structured(
        "新能源 service 配送",
        &json!({"kind": "service", "region": "cn", "capacity": 4}),
        "城市新能源 service 配送",
        &json!({"kind": "service", "region": "cn", "capacity": 2}),
        policy,
    );
    assert_eq!(first, second);
    assert!(first.score > 0.6 && first.score <= 1.0);
    assert!(first.reasons.len() <= 4);
    assert!(
        first
            .reasons
            .iter()
            .all(|reason| reason.chars().count() <= 24)
    );
    assert_eq!(first.advisory, MATCHING_ADVISORY_NOTICE);

    let empty = score_structured(
        "",
        &json!({}),
        "anything",
        &json!({"kind": "anything"}),
        policy,
    );
    assert_eq!(empty.score, 0.0);
    assert!(empty.reasons.is_empty());
}

#[test]
fn null_demand_attributes_are_unspecified_and_never_explained() {
    let policy = StructuredScorePolicy::default();
    let mismatch_with_null = score_structured(
        "",
        &json!({"color": "red", "optional": null}),
        "blue item",
        &json!({"color": "blue", "optional": null}),
        policy,
    );
    assert_eq!(mismatch_with_null.inspected_attributes, 2);
    assert_eq!(mismatch_with_null.score, 0.0);
    assert!(mismatch_with_null.reasons.is_empty());

    let exact_with_null = score_structured(
        "",
        &json!({"color": "red", "optional": null}),
        "red item",
        &json!({"color": "red", "optional": null}),
        policy,
    );
    assert_eq!(exact_with_null.score, 1.0);
    assert_eq!(exact_with_null.reasons, ["shared attribute: color"]);
    assert!(
        exact_with_null
            .reasons
            .iter()
            .all(|reason| !reason.contains("optional"))
    );

    let null_only = score_structured(
        "",
        &json!({"optional": null}),
        "item",
        &json!({"optional": null}),
        policy,
    );
    assert_eq!(null_only.score, 0.0);
    assert!(null_only.reasons.is_empty());
}

#[test]
fn storefront_lexical_rank_keeps_eligibility_formula_and_row_order() -> TestResult {
    let candidates = vec![
        LexicalCandidate {
            display_name: "Cargo bike".to_owned(),
            description: "city".to_owned(),
            eligible: true,
            intent_boost: 0.1,
            intent_reasons: vec!["budget fits".to_owned()],
        },
        LexicalCandidate {
            display_name: "Cargo bike".to_owned(),
            description: "city".to_owned(),
            eligible: false,
            intent_boost: 0.5,
            intent_reasons: Vec::new(),
        },
        LexicalCandidate {
            display_name: "Cargo bike".to_owned(),
            description: "city".to_owned(),
            eligible: true,
            intent_boost: 0.1,
            intent_reasons: vec!["budget fits".to_owned()],
        },
    ];
    let ranked = rank_lexical_candidates(&candidates, "cargo bike", LexicalRankPolicy::default())?;
    assert_eq!(ranked.len(), 2);
    assert_eq!(ranked[0].candidate_index, 0);
    assert_eq!(ranked[1].candidate_index, 2);
    assert_eq!(ranked[0].overlap_count, 2);
    assert!((ranked[0].score - 0.95).abs() < f64::EPSILON);
    assert!(ranked[0].explanations.len() <= 8);
    assert_eq!(ranked[0].overlap_labels, ["cargo", "bike"]);

    let empty = rank_lexical_candidates(&candidates[..1], "", LexicalRankPolicy::default())?;
    assert_eq!(empty.len(), 1);
    assert!((empty[0].score - 0.1).abs() < f64::EPSILON);
    Ok(())
}

#[test]
fn provider_selection_requires_strings_and_observes_unknowns() -> TestResult {
    let malformed = json!({"selectedSlugs": ["known", 7]});
    assert!(matches!(
        parse_provider_decision(&malformed, DecisionPolicy::default()),
        Err(MatchingError::SelectionNotString { index: 1 })
    ));

    let input = ProviderDecisionInput {
        selected_slugs: vec![
            "known".to_owned(),
            "invented".to_owned(),
            "known".to_owned(),
            "other".to_owned(),
        ],
        rationale: Some(format!("  {}  ", "r".repeat(1_100))),
        confidence: Some(1.4),
    };
    let decision =
        normalize_provider_decision(input, &["known", "other"], DecisionPolicy::default())?;
    assert_eq!(decision.selected_slugs, ["known", "other"]);
    assert_eq!(decision.confidence, Some(1.0));
    assert_eq!(decision.rationale.chars().count(), 1_000);
    assert_eq!(decision.rejected.len(), 2);
    assert_eq!(
        decision.rejected[0].reason,
        RejectionReason::UnknownCandidate
    );
    assert_eq!(
        decision.rejected[1].reason,
        RejectionReason::DuplicateCandidate
    );
    assert_eq!(decision.rejection_overflow, 0);
    Ok(())
}

#[test]
fn non_finite_provider_confidence_is_never_presented_as_ai_confidence() -> TestResult {
    for confidence in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let decision = normalize_provider_decision(
            ProviderDecisionInput {
                selected_slugs: vec!["known".to_owned()],
                rationale: None,
                confidence: Some(confidence),
            },
            &["known"],
            DecisionPolicy::default(),
        )?;
        assert_eq!(decision.confidence, None);
    }
    let low = normalize_provider_decision(
        ProviderDecisionInput {
            selected_slugs: vec!["known".to_owned()],
            rationale: None,
            confidence: Some(-1.0),
        },
        &["known"],
        DecisionPolicy::default(),
    )?;
    assert_eq!(low.confidence, Some(0.0));
    Ok(())
}

#[test]
fn candidate_ids_are_exact_bounded_and_never_truncated_into_selections() -> TestResult {
    assert!(matches!(
        validate_candidate_id(""),
        Err(CandidateIdError::Empty)
    ));
    assert!(matches!(
        validate_candidate_id("contains/slash"),
        Err(CandidateIdError::InvalidCharacter { index: 8 })
    ));
    let overlong = "a".repeat(MAX_CANDIDATE_ID_CHARACTERS + 1);
    assert!(matches!(
        validate_candidate_id(&overlong),
        Err(CandidateIdError::TooLong { .. })
    ));

    let mut invalid_fallback = vec![candidate(0)];
    invalid_fallback[0].slug.clear();
    assert!(matches!(
        deterministic_fallback(&invalid_fallback, "bike", None, FallbackPolicy::default()),
        Err(MatchingError::InvalidCandidateId {
            index: 0,
            reason: CandidateIdError::Empty
        })
    ));
    invalid_fallback[0].slug = overlong.clone();
    assert!(matches!(
        deterministic_fallback(&invalid_fallback, "bike", None, FallbackPolicy::default()),
        Err(MatchingError::InvalidCandidateId {
            index: 0,
            reason: CandidateIdError::TooLong { .. }
        })
    ));

    let decision = normalize_provider_decision(
        ProviderDecisionInput {
            selected_slugs: vec![overlong.clone(), String::new()],
            rationale: None,
            confidence: Some(0.5),
        },
        &[overlong.as_str(), ""],
        DecisionPolicy::default(),
    )?;
    assert!(decision.selected_slugs.is_empty());
    assert_eq!(decision.rejected.len(), 2);
    assert!(
        decision
            .rejected
            .iter()
            .all(|item| item.reason == RejectionReason::InvalidCandidateId)
    );
    Ok(())
}

#[test]
fn structured_and_lexical_work_budgets_bound_large_inputs() -> TestResult {
    let policy = StructuredScorePolicy::new(
        TokenPolicy::router(16),
        StructuredDataBudget::new(2, 16, 32, 8, 2),
        2,
        2,
        32,
    );
    let huge = "x".repeat(100_000);
    let result = score_structured(
        "bike 配送",
        &json!({"a": huge, "b": 2, "c": 3}),
        "bike 配送",
        &json!({"a": "x".repeat(100_000), "b": 2, "c": 3}),
        policy,
    );
    assert_eq!(result.inspected_attributes, 2);
    assert_eq!(result.omitted_attributes, 1);
    assert!(result.budget_rejections >= 1);
    assert!(
        result
            .reasons
            .iter()
            .all(|reason| reason.chars().count() <= 32)
    );

    let lexical = vec![LexicalCandidate {
        display_name: format!("bike 配 送 {}", "z".repeat(100_000)),
        description: "bike 配 送".repeat(10_000),
        eligible: true,
        intent_boost: 0.0,
        intent_reasons: Vec::new(),
    }];
    let ranked = rank_lexical_candidates(
        &lexical,
        "bike 配 bike 送 配",
        LexicalRankPolicy::new(1, 1, TokenPolicy::router(16), 8, 64),
    )?;
    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0].overlap_labels, ["bike", "配", "送"]);
    Ok(())
}

#[test]
fn provider_payload_rebuilds_compact_valid_json_without_string_slicing() -> TestResult {
    let mut candidates = (0..32).map(candidate).collect::<Vec<_>>();
    for candidate in &mut candidates {
        candidate.display_name = "🚲".repeat(200);
        candidate.description = "中\"\n".repeat(500);
        candidate.capabilities = vec!["catalog-capability".repeat(20); 20];
        candidate.agent_stages = vec!["retrieval-stage".repeat(20); 12];
        candidate.agent_skills = vec!["agent-skill".repeat(30); 20];
    }
    let payload = build_provider_payload(
        "/商城/🚲",
        &"需求🚲".repeat(3_000),
        &candidates,
        ProviderPayloadPolicy::default(),
    )?;
    assert_eq!(payload.mode, PayloadMode::Compact);
    assert!(payload.serialized_bytes <= 24_000);
    assert_eq!(payload.serialized_bytes, payload.json.len());
    let parsed: Value = serde_json::from_str(&payload.json)?;
    assert!(parsed["candidates"][0].get("description").is_none());
    assert!(
        parsed["userIntent"]
            .as_str()
            .is_some_and(|value| value.is_char_boundary(value.len()))
    );
    Ok(())
}

#[test]
fn provider_payload_rejects_unbounded_shapes_instead_of_truncating_json() {
    let candidates = (0..33).map(candidate).collect::<Vec<_>>();
    assert!(matches!(
        build_provider_payload("/", "intent", &candidates, ProviderPayloadPolicy::default()),
        Err(MatchingError::TooManyCandidates {
            actual: 33,
            maximum: 32
        })
    ));

    let one = vec![candidate(0)];
    assert!(matches!(
        build_provider_payload("/", "intent", &one, ProviderPayloadPolicy::new(32, 8)),
        Err(MatchingError::PayloadTooLarge { .. })
    ));

    let mut empty_id = candidate(0);
    empty_id.slug.clear();
    assert!(matches!(
        build_provider_payload("/", "intent", &[empty_id], ProviderPayloadPolicy::default()),
        Err(MatchingError::InvalidCandidateId {
            index: 0,
            reason: CandidateIdError::Empty
        })
    ));
}

fn candidate(index: usize) -> RouteCandidate {
    RouteCandidate {
        slug: format!("store-{index}"),
        path: format!("/store-{index}"),
        display_name: format!("Store {index}"),
        description: "general catalog".to_owned(),
        capabilities: vec!["catalog.search".to_owned()],
        agent_stages: vec!["retrieval".to_owned()],
        agent_skills: vec!["general-search".to_owned()],
    }
}

fn slugs<'a>(candidates: &'a [&'a RouteCandidate]) -> Vec<&'a str> {
    candidates
        .iter()
        .map(|candidate| candidate.slug.as_str())
        .collect()
}
