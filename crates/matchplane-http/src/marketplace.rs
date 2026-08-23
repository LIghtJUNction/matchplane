use axum::http::{HeaderMap, header};
use sha2::{Digest, Sha256};

use crate::ApiError;

/// Normalizes a platform path header into a canonical `/segment/...` value.
pub fn normalize_platform_path(value: &str) -> Result<String, ApiError> {
    if value.len() > 512 {
        return Err(ApiError::bad_request("platform_path is too long"));
    }
    let normalized = format!(
        "/{}",
        value
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    );
    if normalized == "/"
        || normalized.strip_prefix('/').is_some_and(|path| {
            !path.is_empty()
                && path.split('/').all(|segment| {
                    !segment.is_empty()
                        && segment.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                })
        })
    {
        Ok(normalized)
    } else {
        Err(ApiError::bad_request("platform_path is invalid"))
    }
}

/// Reads an optional or required `x-matchplane-platform-path` header.
pub fn platform_path_from_headers(
    headers: &HeaderMap,
    required: bool,
) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get("x-matchplane-platform-path") else {
        if required {
            return Err(ApiError::bad_request(
                "x-matchplane-platform-path is required for child platform capabilities",
            ));
        }
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::bad_request("platform path header is invalid"))?;
    normalize_platform_path(value).map(Some)
}

/// Hashes a marketplace party bearer token from request headers.
pub fn party_bearer_token_hash(headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("party bearer token is required"))?;
    let token = authorization
        .strip_prefix("Bearer ")
        .filter(|token| token.len() >= 64)
        .ok_or_else(|| ApiError::unauthorized("party bearer token is invalid"))?;
    Ok(Sha256::digest(token.as_bytes()).into())
}

/// Returns the inbound request identifier when present.
pub fn request_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Builds a contact-release fingerprint from request metadata.
pub fn request_fingerprint(headers: &HeaderMap) -> Option<Vec<u8>> {
    let request_id = headers.get("x-request-id")?.to_str().ok()?;
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    Some(Sha256::digest(format!("{request_id}\n{user_agent}").as_bytes()).to_vec())
}
