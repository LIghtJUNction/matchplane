//! Regression tests for truthful storefront lexical matching.

use matchplane_matching::{
    LexicalCandidate, LexicalRankPolicy, MatchingError, TokenPolicy, rank_lexical_candidates,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn empty_browse_without_evidence_returns_empty() -> TestResult {
    let candidates = vec![candidate("Cargo bike", 0.0, Vec::new())];

    let ranked = rank_lexical_candidates(&candidates, "   ", LexicalRankPolicy::default())?;

    assert!(ranked.is_empty());
    Ok(())
}

#[test]
fn zero_overlap_without_evidence_returns_empty() -> TestResult {
    let candidates = vec![candidate("Cargo bike", 0.0, Vec::new())];

    let ranked =
        rank_lexical_candidates(&candidates, "mountain tent", LexicalRankPolicy::default())?;

    assert!(ranked.is_empty());
    Ok(())
}

#[test]
fn empty_and_zero_overlap_use_only_positive_structured_score() -> TestResult {
    let candidates = vec![candidate(
        "Cargo bike",
        0.18,
        vec!["caller-computed budget fit".to_owned()],
    )];

    for narrative in ["", "mountain tent"] {
        let ranked = rank_lexical_candidates(&candidates, narrative, LexicalRankPolicy::default())?;
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].overlap_count, 0);
        assert!((ranked[0].score - 0.18).abs() < f64::EPSILON);
        assert_eq!(ranked[0].explanations, ["caller-computed budget fit"]);
    }
    Ok(())
}

#[test]
fn positive_overlap_preserves_formula_and_deterministic_order() -> TestResult {
    let candidates = vec![
        candidate("alpha beta", 0.0, Vec::new()),
        candidate("alpha", 0.39, Vec::new()),
        candidate("alpha beta", 0.0, Vec::new()),
    ];

    let ranked = rank_lexical_candidates(
        &candidates,
        "alpha beta gamma delta",
        LexicalRankPolicy::default(),
    )?;

    assert_eq!(
        ranked
            .iter()
            .map(|candidate| candidate.candidate_index)
            .collect::<Vec<_>>(),
        [0, 2, 1]
    );
    assert!((ranked[0].score - 0.85).abs() < 1e-12);
    assert!((ranked[1].score - 0.85).abs() < 1e-12);
    assert!((ranked[2].score - 0.99).abs() < 1e-12);
    assert_eq!(ranked[0].overlap_labels, ["alpha", "beta"]);
    Ok(())
}

#[test]
fn non_finite_and_non_positive_boosts_do_not_create_matches() -> TestResult {
    let candidates = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.4, -0.0, 0.0]
        .into_iter()
        .map(|boost| candidate("Cargo bike", boost, Vec::new()))
        .collect::<Vec<_>>();

    let ranked =
        rank_lexical_candidates(&candidates, "mountain tent", LexicalRankPolicy::default())?;

    assert!(ranked.is_empty());
    Ok(())
}

#[test]
fn bounded_intent_reason_can_preserve_a_zero_score_match() -> TestResult {
    let long_reason = format!("  {}  ", "x".repeat(100_000));
    let candidates = vec![candidate(
        "Cargo bike",
        -0.5,
        vec![
            "   ".to_owned(),
            "  caller evidence  ".to_owned(),
            "caller evidence".to_owned(),
            long_reason,
        ],
    )];
    let policy = LexicalRankPolicy::new(1, 1, TokenPolicy::router(16), 4, 16);

    let ranked = rank_lexical_candidates(&candidates, "mountain tent", policy)?;

    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0].score, 0.0);
    assert_eq!(
        ranked[0].explanations,
        ["caller evidence", "xxxxxxxxxxxxxxxx"]
    );
    Ok(())
}

#[test]
fn candidate_and_explanation_limits_remain_typed_and_bounded() -> TestResult {
    let reasons = vec![
        "first reason".to_owned(),
        "second reason is longer".to_owned(),
        "third reason".to_owned(),
    ];
    let candidates = vec![
        candidate("Bike one", 0.0, reasons.clone()),
        candidate("Bike two", 0.0, reasons),
    ];

    let over_budget = rank_lexical_candidates(
        &candidates,
        "bike",
        LexicalRankPolicy::new(1, 1, TokenPolicy::router(16), 2, 12),
    );
    assert!(matches!(
        over_budget,
        Err(MatchingError::TooManyCandidates {
            actual: 2,
            maximum: 1
        })
    ));

    let ranked = rank_lexical_candidates(
        &candidates,
        "bike",
        LexicalRankPolicy::new(2, 1, TokenPolicy::router(16), 2, 12),
    )?;
    assert_eq!(ranked.len(), 1);
    assert_eq!(ranked[0].candidate_index, 0);
    assert_eq!(ranked[0].explanations.len(), 2);
    assert!(
        ranked[0]
            .explanations
            .iter()
            .all(|reason| reason.chars().count() <= 12)
    );
    Ok(())
}

fn candidate(
    display_name: &str,
    intent_boost: f64,
    intent_reasons: Vec<String>,
) -> LexicalCandidate {
    LexicalCandidate {
        display_name: display_name.to_owned(),
        description: String::new(),
        eligible: true,
        intent_boost,
        intent_reasons,
    }
}
