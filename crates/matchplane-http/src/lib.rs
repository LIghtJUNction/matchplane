//! Shared HTTP transport helpers used by MatchPlane service adapters.
//!
//! This crate keeps interface-layer concerns — structured API errors, bearer
//! authentication checks, and request parsing — out of individual binaries.

mod auth;
mod error;
mod marketplace;
mod parse;

#[cfg(feature = "storage")]
mod storage;

pub use auth::{require_bearer, require_operator_bearer};
pub use error::ApiError;
pub use marketplace::{
    normalize_platform_path, party_bearer_token_hash, platform_path_from_headers,
    request_fingerprint, request_id_from_headers,
};
pub use parse::{parse_exact, parse_id, parse_optional_id};

#[cfg(feature = "storage")]
pub use storage::{IntoApiError, storage_api_error};
