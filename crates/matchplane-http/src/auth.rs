use axum::http::{HeaderMap, header};
use matchplane_config::BearerToken;

use crate::ApiError;

/// Verifies an operator bearer token from request headers.
pub fn require_bearer(
    token: &BearerToken,
    headers: &HeaderMap,
    unauthorized: ApiError,
) -> Result<(), ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if token.verify_bearer(authorization) {
        Ok(())
    } else {
        Err(unauthorized)
    }
}

/// Verifies the default operator bearer token used by gateway-style services.
pub fn require_operator_bearer(token: &BearerToken, headers: &HeaderMap) -> Result<(), ApiError> {
    require_bearer(
        token,
        headers,
        ApiError::unauthorized("gateway operator bearer token is required"),
    )
}
