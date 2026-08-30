//! Computation and output budget tests for every public candidate-ranking API.

use matchplane_matching::{
    CandidateWindowPolicy, FallbackPolicy, LexicalCandidate, LexicalRankPolicy, MatchingError,
    RouteCandidate, TokenPolicy, rank_fallback_candidates, rank_lexical_candidates,
    select_candidate_window,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn public_rank_apis_reject_input_over_budget_and_bound_results() -> TestResult {
    assert_eq!(
        CandidateWindowPolicy::default().max_input_candidates(),
        4_096
    );
    assert_eq!(CandidateWindowPolicy::default().max_results(), 32);
    assert_eq!(FallbackPolicy::default().max_input_candidates(), 32);
    assert_eq!(FallbackPolicy::default().max_results(), 4);
    assert_eq!(LexicalRankPolicy::default().max_input_candidates(), 2_000);
    assert_eq!(LexicalRankPolicy::default().max_results(), 2_000);

    let routes = (0..3).map(candidate).collect::<Vec<_>>();
    assert!(matches!(
        select_candidate_window(
            &routes,
            "bike",
            CandidateWindowPolicy::new(2, 1, TokenPolicy::router(16))
        ),
        Err(MatchingError::TooManyCandidates {
            actual: 3,
            maximum: 2
        })
    ));
    assert!(matches!(
        rank_fallback_candidates(
            &routes,
            "bike",
            FallbackPolicy::new(2, 1, 100, TokenPolicy::router(16))
        ),
        Err(MatchingError::TooManyCandidates {
            actual: 3,
            maximum: 2
        })
    ));

    let lexical = vec![lexical_candidate("Bike one"), lexical_candidate("Bike two")];
    assert!(matches!(
        rank_lexical_candidates(
            &lexical,
            "bike",
            LexicalRankPolicy::new(1, 1, TokenPolicy::router(16), 2, 32)
        ),
        Err(MatchingError::TooManyCandidates {
            actual: 2,
            maximum: 1
        })
    ));

    let window = select_candidate_window(
        &routes,
        "bike",
        CandidateWindowPolicy::new(3, 1, TokenPolicy::router(16)),
    )?;
    assert_eq!(window.len(), 1);
    let fallback = rank_fallback_candidates(
        &routes,
        "bike",
        FallbackPolicy::new(3, 1, 100, TokenPolicy::router(16)),
    )?;
    assert_eq!(fallback.len(), 1);
    let lexical = rank_lexical_candidates(
        &lexical,
        "bike",
        LexicalRankPolicy::new(2, 1, TokenPolicy::router(16), 2, 32),
    )?;
    assert_eq!(lexical.len(), 1);
    Ok(())
}

fn candidate(index: usize) -> RouteCandidate {
    RouteCandidate {
        slug: format!("store-{index}"),
        path: format!("/store-{index}"),
        display_name: format!("Store {index}"),
        description: "bike catalog".to_owned(),
        capabilities: vec!["catalog.search".to_owned()],
        agent_stages: vec!["retrieval".to_owned()],
        agent_skills: vec!["general-search".to_owned()],
    }
}

fn lexical_candidate(display_name: &str) -> LexicalCandidate {
    LexicalCandidate {
        display_name: display_name.to_owned(),
        description: String::new(),
        eligible: true,
        intent_boost: 0.0,
        intent_reasons: Vec::new(),
    }
}
