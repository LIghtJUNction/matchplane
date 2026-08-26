use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    routing::post,
};
use matchplane_config::BearerToken;
use matchplane_http::{ApiError, require_operator_bearer};
use matchplane_matching::{
    LexicalCandidate, LexicalRankPolicy, MatchingError, RankedLexicalCandidate, TokenPolicy,
    rank_lexical_candidates,
};
use serde::{Deserialize, Serialize};

const ROUTE: &str = "/v1/internal/matching/lexical-rank";
const MAX_NARRATIVE_CHARACTERS: usize = 8_000;
const MAX_DISPLAY_NAME_CHARACTERS: usize = 512;
const MAX_DESCRIPTION_CHARACTERS: usize = 8_000;
const MAX_INTENT_REASONS: usize = 8;
const MAX_INTENT_REASON_CHARACTERS: usize = 500;
const POLICY: LexicalRankPolicy = LexicalRankPolicy::new(
    64,
    64,
    TokenPolicy::router(512),
    MAX_INTENT_REASONS,
    MAX_INTENT_REASON_CHARACTERS,
);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LexicalRankRequest {
    narrative: String,
    candidates: Vec<LexicalRankCandidate>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LexicalRankCandidate {
    display_name: String,
    description: String,
    eligible: bool,
    intent_boost: f64,
    intent_reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
struct LexicalRankResponse {
    schema_version: u8,
    ranked: Vec<RankedCandidateResponse>,
}

#[derive(Debug, Serialize)]
struct RankedCandidateResponse {
    candidate_index: usize,
    score: f64,
    overlap_count: usize,
    overlap_labels: Vec<String>,
    advisory: &'static str,
}

impl From<RankedLexicalCandidate> for RankedCandidateResponse {
    fn from(candidate: RankedLexicalCandidate) -> Self {
        Self {
            candidate_index: candidate.candidate_index,
            score: candidate.score,
            overlap_count: candidate.overlap_count,
            overlap_labels: candidate.overlap_labels,
            advisory: candidate.advisory,
        }
    }
}

pub(super) fn router(operator_auth: BearerToken) -> Router {
    Router::new()
        .route(ROUTE, post(lexical_rank))
        .with_state(operator_auth)
}

async fn lexical_rank(
    State(operator_auth): State<BearerToken>,
    headers: HeaderMap,
    request: Result<Json<LexicalRankRequest>, JsonRejection>,
) -> Result<Json<LexicalRankResponse>, ApiError> {
    require_operator_bearer(&operator_auth, &headers)?;
    let Json(request) = request.map_err(|_| {
        ApiError::bad_request("request body must match the lexical rank JSON schema")
    })?;
    rank_request(request).map(Json)
}

fn rank_request(request: LexicalRankRequest) -> Result<LexicalRankResponse, ApiError> {
    if request.candidates.len() > POLICY.max_input_candidates() {
        return Err(map_matching_error(MatchingError::TooManyCandidates {
            actual: request.candidates.len(),
            maximum: POLICY.max_input_candidates(),
        }));
    }
    validate_characters(&request.narrative, MAX_NARRATIVE_CHARACTERS, "narrative")?;
    for (candidate_index, candidate) in request.candidates.iter().enumerate() {
        validate_candidate(candidate, candidate_index)?;
    }

    let candidates = request
        .candidates
        .into_iter()
        .map(|candidate| LexicalCandidate {
            display_name: candidate.display_name,
            description: candidate.description,
            eligible: candidate.eligible,
            intent_boost: candidate.intent_boost,
            intent_reasons: candidate.intent_reasons,
        })
        .collect::<Vec<_>>();
    let ranked = rank_lexical_candidates(&candidates, &request.narrative, POLICY)
        .map_err(map_matching_error)?
        .into_iter()
        .map(RankedCandidateResponse::from)
        .collect();

    Ok(LexicalRankResponse {
        schema_version: 1,
        ranked,
    })
}

fn validate_candidate(
    candidate: &LexicalRankCandidate,
    candidate_index: usize,
) -> Result<(), ApiError> {
    validate_characters(
        &candidate.display_name,
        MAX_DISPLAY_NAME_CHARACTERS,
        &format!("candidates[{candidate_index}].display_name"),
    )?;
    validate_characters(
        &candidate.description,
        MAX_DESCRIPTION_CHARACTERS,
        &format!("candidates[{candidate_index}].description"),
    )?;
    if !candidate.intent_boost.is_finite() {
        return Err(ApiError::bad_request(format!(
            "candidates[{candidate_index}].intent_boost must be finite"
        )));
    }
    if candidate.intent_reasons.len() > MAX_INTENT_REASONS {
        return Err(ApiError::bad_request(format!(
            "candidates[{candidate_index}].intent_reasons exceeds {MAX_INTENT_REASONS} entries"
        )));
    }
    for (reason_index, reason) in candidate.intent_reasons.iter().enumerate() {
        validate_characters(
            reason,
            MAX_INTENT_REASON_CHARACTERS,
            &format!("candidates[{candidate_index}].intent_reasons[{reason_index}]"),
        )?;
    }
    Ok(())
}

fn validate_characters(value: &str, maximum: usize, field: &str) -> Result<(), ApiError> {
    if value.chars().nth(maximum).is_some() {
        return Err(ApiError::bad_request(format!(
            "{field} exceeds {maximum} Unicode scalar values"
        )));
    }
    Ok(())
}

fn map_matching_error(error: MatchingError) -> ApiError {
    if matches!(error, MatchingError::TooManyCandidates { .. }) {
        ApiError::bad_request(error.to_string())
    } else {
        ApiError::internal(error)
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, Response, StatusCode, header},
    };
    use matchplane_config::Environment;
    use matchplane_matching::MATCHING_ADVISORY_NOTICE;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;

    const TEST_TOKEN: &str = "lexical-rank-test-operator-token";

    fn test_router() -> Router {
        let token = BearerToken::load(
            Environment::Development,
            "MATCHPLANE_LEXICAL_RANK_TEST_TOKEN_FILE_UNUSED",
            "MATCHPLANE_LEXICAL_RANK_TEST_TOKEN_UNUSED",
            TEST_TOKEN,
        )
        .expect("test bearer should be valid");
        router(token)
    }

    fn candidate(
        display_name: impl Into<String>,
        description: impl Into<String>,
        eligible: bool,
        intent_boost: f64,
        intent_reasons: Vec<String>,
    ) -> Value {
        json!({
            "display_name": display_name.into(),
            "description": description.into(),
            "eligible": eligible,
            "intent_boost": intent_boost,
            "intent_reasons": intent_reasons,
        })
    }

    fn request(body: impl Into<Body>, authenticated: bool) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(ROUTE)
            .header(header::CONTENT_TYPE, "application/json");
        if authenticated {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {TEST_TOKEN}"));
        }
        builder.body(body.into()).expect("request should build")
    }

    async fn response_json(response: Response<Body>) -> Value {
        let body = to_bytes(response.into_body(), 1_048_576)
            .await
            .expect("response body should be bounded");
        serde_json::from_slice(&body).expect("response should be JSON")
    }

    async fn post_json(body: Value) -> (StatusCode, Value) {
        let response = test_router()
            .oneshot(request(body.to_string(), true))
            .await
            .expect("router should respond");
        let status = response.status();
        (status, response_json(response).await)
    }

    #[tokio::test]
    async fn route_requires_operator_before_handling_json() {
        let response = test_router()
            .oneshot(request("not-json", false))
            .await
            .expect("router should respond");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response_json(response).await,
            json!({
                "code": "unauthorized",
                "error": "gateway operator bearer token is required"
            })
        );

        let response = test_router()
            .oneshot(request("not-json", true))
            .await
            .expect("router should respond");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await,
            json!({
                "code": "invalid_request",
                "error": "request body must match the lexical rank JSON schema"
            })
        );
    }

    #[tokio::test]
    async fn endpoint_accepts_64_and_rejects_65_without_truncation() {
        let candidates = (0..64)
            .map(|index| candidate(format!("candidate {index}"), "", true, 0.1, Vec::new()))
            .collect::<Vec<_>>();
        let (status, body) = post_json(json!({"narrative": "", "candidates": candidates})).await;
        assert_eq!(status, StatusCode::OK);
        let ranked = body["ranked"]
            .as_array()
            .expect("ranked should be an array");
        assert_eq!(ranked.len(), 64);
        assert_eq!(ranked[0]["candidate_index"], 0);
        assert_eq!(ranked[63]["candidate_index"], 63);

        let candidates = (0..65)
            .map(|index| candidate(format!("candidate {index}"), "", true, 0.1, Vec::new()))
            .collect::<Vec<_>>();
        let (status, body) = post_json(json!({"narrative": "", "candidates": candidates})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "invalid_request");
        assert_eq!(
            body["error"],
            "received 65 candidates, exceeding the limit of 64"
        );
        assert!(body.get("ranked").is_none());
    }

    #[tokio::test]
    async fn endpoint_omits_empty_and_zero_overlap_without_evidence() {
        for narrative in ["", "mountain tent"] {
            let body = json!({
                "narrative": narrative,
                "candidates": [candidate("Cargo bike", "city", true, 0.0, vec!["".into()])]
            });
            let (status, body) = post_json(body).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["ranked"], json!([]));
        }
    }

    #[tokio::test]
    async fn endpoint_maps_overlap_and_structured_evidence_to_v1_schema() {
        let body = json!({
            "narrative": "alpha beta gamma delta",
            "candidates": [
                candidate("alpha beta", "", true, -0.1, Vec::new()),
                candidate("unrelated", "", true, 0.2, vec!["caller evidence".into()]),
                candidate("alpha beta", "", false, 0.9, vec!["not eligible".into()])
            ]
        });
        let (status, body) = post_json(body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["schema_version"], 1);
        assert_eq!(
            body.as_object()
                .expect("response should be an object")
                .keys()
                .collect::<Vec<_>>(),
            ["ranked", "schema_version"]
        );
        let ranked = body["ranked"]
            .as_array()
            .expect("ranked should be an array");
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0]["candidate_index"], 0);
        assert!((ranked[0]["score"].as_f64().expect("score") - 0.75).abs() < 1e-12);
        assert_eq!(ranked[0]["overlap_count"], 2);
        assert_eq!(ranked[0]["overlap_labels"], json!(["alpha", "beta"]));
        assert_eq!(ranked[1]["candidate_index"], 1);
        assert_eq!(ranked[1]["score"], 0.2);
        assert_eq!(ranked[1]["overlap_count"], 0);
        assert_eq!(ranked[1]["overlap_labels"], json!([]));
        for item in ranked {
            assert_eq!(item["advisory"], MATCHING_ADVISORY_NOTICE);
            assert_eq!(item.as_object().expect("ranked item").len(), 5);
            let score = item["score"].as_f64().expect("score should be finite");
            assert!((0.0..=0.99).contains(&score));
            assert!(item.get("explanations").is_none());
            assert!(item.get("confidence").is_none());
        }
    }

    #[tokio::test]
    async fn endpoint_rejects_character_and_reason_budgets() {
        let valid = candidate("name", "description", true, 0.0, Vec::new());
        let invalid_requests = [
            json!({"narrative": "界".repeat(8_001), "candidates": []}),
            json!({"narrative": "", "candidates": [candidate("界".repeat(513), "", true, 0.0, Vec::new())]}),
            json!({"narrative": "", "candidates": [candidate("name", "界".repeat(8_001), true, 0.0, Vec::new())]}),
            json!({"narrative": "", "candidates": [candidate("name", "", true, 0.0, vec!["reason".into(); 9])]}),
            json!({"narrative": "", "candidates": [candidate("name", "", true, 0.0, vec!["界".repeat(501)])]}),
            json!({"narrative": "", "candidates": [valid], "unexpected": true}),
        ];
        for invalid in invalid_requests {
            let (status, body) = post_json(invalid).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body["code"], "invalid_request");
            assert!(body.get("ranked").is_none());
        }

        let error = rank_request(LexicalRankRequest {
            narrative: String::new(),
            candidates: vec![LexicalRankCandidate {
                display_name: "name".into(),
                description: String::new(),
                eligible: true,
                intent_boost: f64::NAN,
                intent_reasons: Vec::new(),
            }],
        })
        .expect_err("non-finite boost should fail closed");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn endpoint_preserves_deterministic_tie_order() {
        let candidates = (0..3)
            .map(|_| candidate("alpha", "", true, 0.0, Vec::new()))
            .collect::<Vec<_>>();
        let (status, body) =
            post_json(json!({"narrative": "alpha", "candidates": candidates})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["ranked"]
                .as_array()
                .expect("ranked should be an array")
                .iter()
                .map(|item| item["candidate_index"].as_u64().expect("candidate index"))
                .collect::<Vec<_>>(),
            [0, 1, 2]
        );
    }
}
